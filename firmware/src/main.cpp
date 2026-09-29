#include <Arduino.h>
#include <Wire.h>
#include <math.h>
#include <ArduinoJson.h>
#include <Adafruit_INA219.h>
#include <LittleFS.h>
#include <PubSubClient.h>
#include <WiFi.h>
#include "config.h"

WiFiClient networkClient;
PubSubClient mqttClient(networkClient);
Adafruit_INA219 ina219(INA219_I2C_ADDRESS);

struct SessionState {
  bool active = false;
  long sessionId = 0;
  uint32_t intervalSeconds = DEFAULT_INTERVAL_SECONDS;
  uint32_t elapsedSeconds = 0;
  uint32_t lastSampleMillis = 0;
};

SessionState session;
unsigned long nextWifiAttempt = 0;
unsigned long nextMqttAttempt = 0;
unsigned long wifiBackoff = 1000;
unsigned long mqttBackoff = 1000;
bool littleFsReady = false;
bool flushingQueue = false;

void saveSessionState() {
  if (!littleFsReady) return;
  File file = LittleFS.open(SESSION_STATE_PATH, FILE_WRITE);
  if (!file) {
    Serial.println("LittleFS: gagal membuka state sesi");
    return;
  }
  JsonDocument document;
  document["active"] = session.active;
  document["session_id"] = session.sessionId;
  document["interval_s"] = session.intervalSeconds;
  document["elapsed_seconds"] = session.elapsedSeconds;
  serializeJson(document, file);
  file.close();
}

void loadSessionState() {
  if (!littleFsReady || !LittleFS.exists(SESSION_STATE_PATH)) return;
  File file = LittleFS.open(SESSION_STATE_PATH, FILE_READ);
  if (!file) return;
  JsonDocument document;
  if (deserializeJson(document, file) == DeserializationError::Ok) {
    session.active = document["active"] | false;
    session.sessionId = document["session_id"] | 0L;
    session.intervalSeconds = max(1UL, document["interval_s"] | (uint32_t)DEFAULT_INTERVAL_SECONDS);
    session.elapsedSeconds = document["elapsed_seconds"] | 0UL;
  }
  file.close();
}

void appendOfflinePayload(const String &payload) {
  if (!littleFsReady) return;
  File file = LittleFS.open(OFFLINE_QUEUE_PATH, FILE_APPEND);
  if (!file) {
    Serial.println("LittleFS: gagal menulis buffer telemetry");
    return;
  }
  file.println(payload);
  file.close();
}

bool publishTelemetryPayload(const String &payload) {
  if (!mqttClient.connected()) return false;
  return mqttClient.publish(MQTT_TELEMETRY_TOPIC, payload.c_str());
}

void flushOfflineQueue() {
  if (!littleFsReady || flushingQueue || !mqttClient.connected() || !LittleFS.exists(OFFLINE_QUEUE_PATH)) return;
  flushingQueue = true;
  File input = LittleFS.open(OFFLINE_QUEUE_PATH, FILE_READ);
  if (!input) {
    flushingQueue = false;
    return;
  }
  String remaining;
  bool failed = false;
  while (input.available()) {
    String line = input.readStringUntil('\n');
    line.trim();
    if (line.isEmpty()) continue;
    if (!failed && !publishTelemetryPayload(line)) failed = true;
    if (failed) {
      remaining += line;
      remaining += '\n';
    }
    mqttClient.loop();
  }
  input.close();
  if (failed) {
    File output = LittleFS.open(OFFLINE_QUEUE_PATH, FILE_WRITE);
    if (output) {
      output.print(remaining);
      output.close();
    }
  } else {
    LittleFS.remove(OFFLINE_QUEUE_PATH);
  }
  flushingQueue = false;
}

void publishAck(const char *action, bool ok) {
  if (!mqttClient.connected()) return;
  JsonDocument document;
  document["action"] = action;
  document["session_id"] = session.sessionId;
  document["ok"] = ok;
  document["t"] = session.elapsedSeconds;
  String payload;
  serializeJson(document, payload);
  mqttClient.publish(MQTT_ACK_TOPIC, payload.c_str());
}

void applyCommand(JsonDocument &document) {
  const char *action = document["action"] | "";
  long commandSessionId = document["session_id"] | 0L;
  if (strcmp(action, "start") == 0 && commandSessionId > 0) {
    if (session.sessionId != commandSessionId) {
      session.elapsedSeconds = document["t"] | 0UL;
    } else {
      // Checkpoint LittleFS diprioritaskan; t dari command hanya menjadi fallback.
      uint32_t commandElapsed = document["t"] | session.elapsedSeconds;
      session.elapsedSeconds = max(session.elapsedSeconds, commandElapsed);
    }
    session.sessionId = commandSessionId;
    session.intervalSeconds = max(1UL, document["interval_s"] | (uint32_t)DEFAULT_INTERVAL_SECONDS);
    session.active = true;
    session.lastSampleMillis = millis();
    saveSessionState();
    publishAck("start", true);
    Serial.printf("Sesi start: %ld, interval %lu s, t=%lu\n", session.sessionId, session.intervalSeconds, session.elapsedSeconds);
  } else if (strcmp(action, "stop") == 0 && commandSessionId == session.sessionId) {
    session.active = false;
    saveSessionState();
    publishAck("stop", true);
    Serial.printf("Sesi stop: %ld\n", session.sessionId);
  } else {
    publishAck(action, false);
    Serial.println("Command MQTT tidak valid atau bukan untuk sesi aktif");
  }
}

void mqttMessageCallback(char *topic, byte *payload, unsigned int length) {
  if (strcmp(topic, MQTT_COMMAND_TOPIC) != 0) return;
  JsonDocument document;
  DeserializationError error = deserializeJson(document, payload, length);
  if (error) {
    Serial.printf("MQTT cmd JSON invalid: %s\n", error.c_str());
    return;
  }
  applyCommand(document);
}

void publishDeviceStatus(const char *status) {
  if (mqttClient.connected()) mqttClient.publish(MQTT_STATUS_TOPIC, status, true);
}

bool connectMqtt() {
  if (mqttClient.connected()) return true;
  String willPayload = "offline";
  bool connected = mqttClient.connect(
    MQTT_CLIENT_ID,
    MQTT_USERNAME,
    MQTT_PASSWORD,
    MQTT_STATUS_TOPIC,
    0,
    true,
    willPayload.c_str()
  );
  if (!connected) {
    Serial.printf("MQTT connect gagal, state=%d\n", mqttClient.state());
    return false;
  }
  mqttClient.subscribe(MQTT_COMMAND_TOPIC, 1);
  publishDeviceStatus("online");
  Serial.println("MQTT connected; status online; subscribe mstr/cmd");
  flushOfflineQueue();
  return true;
}

void maintainWiFi() {
  if (WiFi.status() == WL_CONNECTED) {
    wifiBackoff = 1000;
    return;
  }
  unsigned long now = millis();
  if (now < nextWifiAttempt) return;
  Serial.println("WiFi menghubungkan ulang...");
  WiFi.disconnect();
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  nextWifiAttempt = now + wifiBackoff;
  wifiBackoff = min(wifiBackoff * 2, 30000UL);
}

void maintainMqtt() {
  if (WiFi.status() != WL_CONNECTED || mqttClient.connected()) return;
  unsigned long now = millis();
  if (now < nextMqttAttempt) return;
  if (connectMqtt()) {
    mqttBackoff = 1000;
  } else {
    nextMqttAttempt = now + mqttBackoff;
    mqttBackoff = min(mqttBackoff * 2, 30000UL);
  }
}

bool readAveraged(float &voltage, float &current, float &power) {
  float voltageSum = 0;
  float currentSum = 0;
  float powerSum = 0;
  for (uint8_t sample = 0; sample < TELEMETRY_SAMPLES; sample++) {
    voltageSum += ina219.getBusVoltage_V();
    currentSum += ina219.getCurrent_mA();
    powerSum += ina219.getPower_mW();
    delay(4);
  }
  voltage = voltageSum / TELEMETRY_SAMPLES;
  current = currentSum / TELEMETRY_SAMPLES;
  power = powerSum / TELEMETRY_SAMPLES;
  return isfinite(voltage) && isfinite(current) && isfinite(power);
}

void publishMeasurement() {
  float voltage;
  float current;
  float power;
  if (!readAveraged(voltage, current, power)) {
    Serial.println("INA219: pembacaan tidak valid");
    return;
  }
  JsonDocument document;
  document["session_id"] = session.sessionId;
  document["t"] = session.elapsedSeconds;
  document["v"] = voltage;
  document["i"] = current;
  document["p"] = power;
  String payload;
  serializeJson(document, payload);
  if (!publishTelemetryPayload(payload)) {
    appendOfflinePayload(payload);
    Serial.println("Telemetry disimpan ke buffer LittleFS");
  } else {
    Serial.println("Telemetry terkirim: " + payload);
  }
  session.elapsedSeconds += session.intervalSeconds;
  saveSessionState();
}

void setup() {
  Serial.begin(115200);
  delay(200);
  Wire.begin(I2C_SDA_PIN, I2C_SCL_PIN);
  ina219.begin();
  // Untuk arus kecil. Jika shunt/range modul berbeda, ubah kalibrasi dan verifikasi dengan multimeter.
  ina219.setCalibration_16V_400mA();

  littleFsReady = LittleFS.begin(true);
  if (!littleFsReady) Serial.println("LittleFS gagal di-mount");
  loadSessionState();

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  mqttClient.setServer(MQTT_HOST, MQTT_PORT);
  mqttClient.setCallback(mqttMessageCallback);
  Serial.println("MSTR firmware siap");
}

void loop() {
  maintainWiFi();
  maintainMqtt();
  if (mqttClient.connected()) mqttClient.loop();
  if (mqttClient.connected()) flushOfflineQueue();

  if (session.active && millis() - session.lastSampleMillis >= session.intervalSeconds * 1000UL) {
    session.lastSampleMillis = millis();
    publishMeasurement();
  }
  delay(10);
}
