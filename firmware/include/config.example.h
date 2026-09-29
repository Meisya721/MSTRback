#pragma once

// Salin/ubah nilai ini di include/config.h sebelum upload.
#define WIFI_SSID "GANTI_DENGAN_SSID"
#define WIFI_PASSWORD "GANTI_DENGAN_PASSWORD"

#define MQTT_HOST "192.168.1.10"
#define MQTT_PORT 1883
#define MQTT_USERNAME ""
#define MQTT_PASSWORD ""

#define MQTT_TELEMETRY_TOPIC "mstr/telemetry"
#define MQTT_STATUS_TOPIC "mstr/status"
#define MQTT_COMMAND_TOPIC "mstr/cmd"
#define MQTT_ACK_TOPIC "mstr/ack"
#define MQTT_CLIENT_ID "mstr-esp32"

#define I2C_SDA_PIN 21
#define I2C_SCL_PIN 22
#define INA219_I2C_ADDRESS 0x40
#define OFFLINE_QUEUE_PATH "/telemetry.ndjson"
#define SESSION_STATE_PATH "/session.json"
#define TELEMETRY_SAMPLES 10
#define DEFAULT_INTERVAL_SECONDS 10
