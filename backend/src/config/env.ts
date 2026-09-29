import "dotenv/config";

function requiredNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value ?? fallback);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export const env = {
  port: requiredNumber(process.env.PORT, 4000),
  frontendOrigins: (process.env.FRONTEND_ORIGINS ?? "http://localhost:3000")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
  mysql: {
    host: process.env.MYSQL_HOST ?? "localhost",
    port: requiredNumber(process.env.MYSQL_PORT, 3306),
    database: process.env.MYSQL_DATABASE ?? "mstr",
    user: process.env.MYSQL_USER ?? "root",
    password: process.env.MYSQL_PASSWORD ?? "",
  },
  mqtt: {
    enabled: process.env.MQTT_ENABLED !== "false",
    url: process.env.MQTT_URL ?? "mqtt://localhost:1883",
    telemetryTopic: process.env.MQTT_TOPIC ?? "mstr/telemetry",
    statusTopic: process.env.MQTT_STATUS_TOPIC ?? "mstr/status",
    ackTopic: process.env.MQTT_ACK_TOPIC ?? "mstr/ack",
    commandTopic: process.env.MQTT_COMMAND_TOPIC ?? "mstr/cmd",
    deviceId: process.env.MQTT_DEVICE_ID ?? "mstr-device",
  },
};