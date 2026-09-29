import mqtt, { type MqttClient } from "mqtt";
import { env } from "../config/env.js";
import {
  isRunningSession,
  saveTelemetry,
  touchDevice,
  updateDeviceStatus,
} from "../config/database.js";
import type { Telemetry } from "../types/telemetry.js";

const subscribedTopics = [
  env.mqtt.telemetryTopic,
  env.mqtt.statusTopic,
  env.mqtt.ackTopic,
];

let client: MqttClient | undefined;
let connected = false;

function numberInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}

function parseTelemetry(payload: string): Telemetry {
  const value = JSON.parse(payload) as Record<string, unknown>;
  if (!Number.isInteger(value.session_id) || (value.session_id as number) <= 0) {
    throw new Error("session_id harus berupa bilangan bulat positif");
  }
  if (!Number.isInteger(value.t) || (value.t as number) < 0) {
    throw new Error("t harus berupa detik bilangan bulat >= 0");
  }
  if (!numberInRange(value.v, 0, 5)) throw new Error("v di luar rentang 0..5 V");
  if (!numberInRange(value.i, 0, 10000)) throw new Error("i di luar rentang 0..10000 mA");
  if (!numberInRange(value.p, 0, 50000)) throw new Error("p di luar rentang 0..50000 mW");

  return {
    sessionId: value.session_id as number,
    elapsedSeconds: value.t as number,
    voltageV: value.v as number,
    currentMa: value.i as number,
    powerMw: value.p as number,
  };
}

function parseStatus(payload: string): { deviceId: string; status: "online" | "offline" } {
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(payload) as Record<string, unknown>;
  } catch {
    value = { status: payload.trim() };
  }
  if (value.status !== "online" && value.status !== "offline") {
    throw new Error("status harus bernilai online atau offline");
  }
  return {
    deviceId: typeof value.device_id === "string" && value.device_id.trim()
      ? value.device_id
      : env.mqtt.deviceId,
    status: value.status,
  };
}

async function handleTelemetry(payload: string): Promise<void> {
  const telemetry = parseTelemetry(payload);
  if (!(await isRunningSession(telemetry.sessionId))) {
    throw new Error(`session_id ${telemetry.sessionId} tidak berstatus running`);
  }
  await saveTelemetry(telemetry);
  await touchDevice(env.mqtt.deviceId);
}

async function handleMessage(topic: string, payload: Buffer): Promise<void> {
  const text = payload.toString();
  try {
    if (topic === env.mqtt.telemetryTopic) {
      await handleTelemetry(text);
      return;
    }
    if (topic === env.mqtt.statusTopic) {
      const status = parseStatus(text);
      await updateDeviceStatus(status.deviceId, status.status);
      console.log(`MQTT status: ${status.deviceId} ${status.status}`);
      return;
    }
    if (topic === env.mqtt.ackTopic) {
      console.log(`MQTT ack: ${text}`);
    }
  } catch (error) {
    console.error(`MQTT payload dibuang [${topic}]:`, error instanceof Error ? error.message : error);
  }
}

export function startMqtt(): void {
  if (client) return;
  client = mqtt.connect(env.mqtt.url, { reconnectPeriod: 5000 });
  client.on("connect", () => {
    connected = true;
    client?.subscribe(subscribedTopics, { qos: 1 }, (error) => {
      if (error) console.error("MQTT subscribe error:", error.message);
      else console.log(`MQTT connected; subscribed: ${subscribedTopics.join(", ")}`);
    });
  });
  client.on("reconnect", () => {
    connected = false;
    console.warn("MQTT reconnecting...");
  });
  client.on("close", () => {
    connected = false;
    console.warn("MQTT connection closed");
  });
  client.on("error", (error) => console.error("MQTT error:", error.message));
  client.on("message", (topic, payload) => {
    void handleMessage(topic, payload);
  });
}

export function publishCommand(command: object): Promise<void> {
  if (!client || !connected) return Promise.reject(new Error("MQTT belum terhubung"));
  return new Promise((resolve, reject) => {
    client?.publish(
      env.mqtt.commandTopic,
      JSON.stringify(command),
      { qos: 1, retain: true },
      (error) => (error ? reject(error) : resolve()),
    );
  });
}

export function isMqttConnected(): boolean {
  return connected;
}

export async function stopMqtt(): Promise<void> {
  connected = false;
  if (!client) return;
  const mqttClient = client;
  client = undefined;
  await new Promise<void>((resolve, reject) => {
    mqttClient.end(false, {}, (error) => (error ? reject(error) : resolve()));
  });
}