import cors from "cors";
import express from "express";
import type { RowDataPacket } from "mysql2";
import { checkDatabase, pool } from "./config/database.js";
import { env } from "./config/env.js";
import { substrateRouter } from "./routes/substrate.routes.js";
import { sessionDataRouter } from "./routes/session-data.routes.js";
import { telemetryRouter } from "./routes/telemetry.routes.js";
import { isMqttConnected, startMqtt, stopMqtt } from "./services/mqtt.service.js";

const app = express();
app.use(cors({ origin: env.frontendOrigins }));
app.use(express.json());

app.get("/api/health", async (_request, response) => {
  const mysqlOk = await checkDatabase();
  let dataLastAt: string | null = null;
  let dataStale = true;
  try {
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT MAX(m.created_at) AS last_at, s.interval_seconds
         FROM sessions s
         LEFT JOIN measurements m ON m.session_id = s.id
        WHERE s.status = 'running'
        GROUP BY s.id, s.interval_seconds
        LIMIT 1`,
    );
    const active = rows[0];
    if (active?.last_at) {
      dataLastAt = new Date(active.last_at).toISOString();
      dataStale = Date.now() - new Date(active.last_at).getTime() > active.interval_seconds * 3 * 1000;
    }
  } catch (error) {
    console.error("Health data check failed:", error);
  }

  const mqttOk = !env.mqtt.enabled || isMqttConnected();
  response.json({
    status: mysqlOk && mqttOk && !dataStale ? "ok" : "degraded",
    mysql: { connected: mysqlOk },
    mqtt: { enabled: env.mqtt.enabled, connected: isMqttConnected() },
    data: { stale: dataStale, last_at: dataLastAt },
    timestamp: new Date().toISOString(),
  });
});

app.use("/api", telemetryRouter);
app.use("/api", substrateRouter);
app.use("/api", sessionDataRouter);

app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
  console.error(error);
  response.status(500).json({ error: "Internal server error" });
});

const server = app.listen(env.port, () => {
  console.log(`Backend listening on http://localhost:${env.port}`);
  if (env.mqtt.enabled) {
    startMqtt();
  } else {
    console.log("MQTT disabled by MQTT_ENABLED=false");
  }
});

async function shutdown(signal: string): Promise<void> {
  console.log(`${signal} received, shutting down backend...`);
  server.close(async () => {
    await stopMqtt();
    await pool.end();
    process.exit(0);
  });
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));