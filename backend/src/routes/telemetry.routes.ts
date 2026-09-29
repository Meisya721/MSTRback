import { Router } from "express";
import type { ResultSetHeader, RowDataPacket } from "mysql2";
import { pool } from "../config/database.js";
import { isMqttConnected, publishCommand } from "../services/mqtt.service.js";
import { calculateSessionStats, getSessionReadings } from "../services/session-stats.js";

export const telemetryRouter = Router();

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function requiredInteger(value: unknown, field: string, minimum = 1): number {
  if (!Number.isInteger(value) || (value as number) < minimum) {
    throw new Error(`${field} harus berupa bilangan bulat >= ${minimum}`);
  }
  return value as number;
}

function optionalNumber(value: unknown, field: string, minimum?: number, maximum?: number): number | null {
  if (value === undefined || value === null || value === "") return null;
  if (!isFiniteNumber(value) || (minimum !== undefined && value < minimum) || (maximum !== undefined && value > maximum)) {
    throw new Error(`${field} memiliki nilai tidak valid`);
  }
  return value;
}

function sessionPayload(body: Record<string, unknown>) {
  const substrateId = requiredInteger(body.substrate_id, "substrate_id");
  const replicate = body.replicate === undefined ? 1 : requiredInteger(body.replicate, "replicate");
  const ph = optionalNumber(body.ph, "ph", 0, 14);
  const temperatureC = optionalNumber(body.temperature_c, "temperature_c", -50, 150);
  const volumeMl = optionalNumber(body.volume_ml, "volume_ml", 0);
  const anodeAreaCm2 = optionalNumber(body.anode_area_cm2, "anode_area_cm2", 0);
  const loadResistorOhm = optionalNumber(body.load_resistor_ohm, "load_resistor_ohm", 0);
  const intervalSeconds = body.interval_seconds === undefined
    ? 10
    : requiredInteger(body.interval_seconds, "interval_seconds");
  const voltageThresholdV = body.voltage_threshold_v === undefined
    ? 0.3
    : optionalNumber(body.voltage_threshold_v, "voltage_threshold_v", 0, 5);

  if (intervalSeconds > 86400) throw new Error("interval_seconds di luar rentang");
  return {
    substrateId,
    replicate,
    ph,
    temperatureC,
    volumeMl,
    anodeAreaCm2,
    loadResistorOhm,
    intervalSeconds,
    voltageThresholdV: voltageThresholdV ?? 0.3,
    notes: typeof body.notes === "string" ? body.notes : null,
  };
}

telemetryRouter.get("/measurements", async (request, response) => {
  const limit = Math.min(Math.max(Number(request.query.limit) || 50, 1), 500);
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT id, session_id AS sessionId, elapsed_seconds AS elapsedSeconds,
            voltage_v AS voltage, current_ma / 1000 AS current,
            power_mw / 1000 AS power, created_at AS timestamp
       FROM measurements ORDER BY created_at DESC, id DESC LIMIT ?`,
    [limit],
  );
  response.json(rows);
});

telemetryRouter.get("/measurements/latest", async (_request, response) => {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT id, session_id AS sessionId, elapsed_seconds AS elapsedSeconds,
            voltage_v AS voltage, current_ma / 1000 AS current,
            power_mw / 1000 AS power, created_at AS timestamp
       FROM measurements ORDER BY created_at DESC, id DESC LIMIT 1`,
  );
  response.json(rows[0] ?? null);
});

telemetryRouter.post("/sessions", async (request, response) => {
  try {
    const input = sessionPayload(request.body as Record<string, unknown>);
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const [running] = await connection.query<RowDataPacket[]>(
        "SELECT id FROM sessions WHERE status = 'running' LIMIT 1 FOR UPDATE",
      );
      if (running.length > 0) {
        await connection.rollback();
        response.status(409).json({ error: `Sesi ${running[0].id} masih running` });
        return;
      }
      const [result] = await connection.execute<ResultSetHeader>(
        `INSERT INTO sessions
          (substrate_id, replicate, ph, temperature_c, volume_ml, anode_area_cm2,
           load_resistor_ohm, interval_seconds, voltage_threshold_v, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [input.substrateId, input.replicate, input.ph, input.temperatureC, input.volumeMl,
          input.anodeAreaCm2, input.loadResistorOhm, input.intervalSeconds,
          input.voltageThresholdV, input.notes],
      );
      await connection.commit();
      const sessionId = result.insertId;
      try {
        await publishCommand({ action: "start", session_id: sessionId, interval_s: input.intervalSeconds });
      } catch (error) {
        response.status(503).json({ error: "Sesi dibuat, tetapi command start gagal dipublikasikan ke MQTT", session_id: sessionId });
        return;
      }
      response.status(201).json({ session_id: sessionId, command_published: true });
    } catch (error) {
      await connection.rollback();
      if ((error as { code?: string }).code === "ER_DUP_ENTRY") {
        response.status(409).json({ error: "Substrat dan replicate tersebut sudah digunakan" });
        return;
      }
      throw error;
    } finally {
      connection.release();
    }
  } catch (error) {
    response.status(400).json({ error: error instanceof Error ? error.message : "Payload sesi tidak valid" });
  }
});

telemetryRouter.post("/sessions/:id/stop", async (request, response) => {
  const sessionId = Number(request.params.id);
  if (!Number.isInteger(sessionId) || sessionId < 1) {
    response.status(400).json({ error: "id sesi tidak valid" });
    return;
  }
  const [result] = await pool.execute<ResultSetHeader>(
    "UPDATE sessions SET status = 'stopped', ended_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'running'",
    [sessionId],
  );
  if (result.affectedRows === 0) {
    const [rows] = await pool.query<RowDataPacket[]>("SELECT id, status FROM sessions WHERE id = ?", [sessionId]);
    if (rows.length === 0) response.status(404).json({ error: "Sesi tidak ditemukan" });
    else response.status(409).json({ error: `Sesi sudah berstatus ${rows[0].status}` });
    return;
  }
  try {
    await publishCommand({ action: "stop", session_id: sessionId });
  } catch {
    response.status(503).json({ error: "Sesi dihentikan, tetapi command stop gagal dipublikasikan ke MQTT" });
    return;
  }
  response.json({ session_id: sessionId, status: "stopped", command_published: true });
});

telemetryRouter.get("/sessions", async (request, response) => {
  const substrateId = request.query.substrate_id === undefined ? null : Number(request.query.substrate_id);
  if (substrateId !== null && (!Number.isInteger(substrateId) || substrateId < 1)) {
    response.status(400).json({ error: "substrate_id tidak valid" });
    return;
  }
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT s.*, sub.code AS substrate_code, sub.name AS substrate_name
       FROM sessions s JOIN substrates sub ON sub.id = s.substrate_id
      WHERE (? IS NULL OR s.substrate_id = ?)
      ORDER BY s.started_at DESC, s.id DESC`,
    [substrateId, substrateId],
  );
  response.json(rows);
});

telemetryRouter.get("/sessions/:id", async (request, response) => {
  const sessionId = Number(request.params.id);
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT s.*, sub.code AS substrate_code, sub.name AS substrate_name
       FROM sessions s JOIN substrates sub ON sub.id = s.substrate_id WHERE s.id = ?`,
    [sessionId],
  );
  if (rows.length === 0) {
    response.status(404).json({ error: "Sesi tidak ditemukan" });
    return;
  }
  const session = rows[0];
  const readings = await getSessionReadings(sessionId);
  response.json({
    ...session,
    stats: calculateSessionStats(
      readings,
      session.anode_area_cm2 === null ? null : Number(session.anode_area_cm2),
      Number(session.voltage_threshold_v),
    ),
  });
});

telemetryRouter.delete("/sessions/:id", async (request, response) => {
  const sessionId = Number(request.params.id);
  const [result] = await pool.execute<ResultSetHeader>(
    "DELETE FROM sessions WHERE id = ? AND status <> 'running'",
    [sessionId],
  );
  if (result.affectedRows > 0) {
    response.status(204).send();
    return;
  }
  const [rows] = await pool.query<RowDataPacket[]>("SELECT status FROM sessions WHERE id = ?", [sessionId]);
  if (rows.length === 0) response.status(404).json({ error: "Sesi tidak ditemukan" });
  else response.status(409).json({ error: "Sesi running tidak boleh dihapus" });
});

telemetryRouter.get("/live", async (_request, response) => {
  const [sessions] = await pool.query<RowDataPacket[]>(
    `SELECT s.*, sub.code AS substrate_code, sub.name AS substrate_name
       FROM sessions s JOIN substrates sub ON sub.id = s.substrate_id
      WHERE s.status = 'running' LIMIT 1`,
  );
  if (sessions.length === 0) {
    response.json({ session: null, latest: null, energy_wh: 0, device: null, data_last_at: null });
    return;
  }
  const session = sessions[0];
  const [latestRows] = await pool.query<RowDataPacket[]>(
    `SELECT id, session_id AS sessionId, elapsed_seconds AS elapsedSeconds,
            voltage_v AS voltage, current_ma AS currentMa, power_mw AS powerMw,
            created_at AS timestamp FROM measurements
      WHERE session_id = ? ORDER BY elapsed_seconds DESC, id DESC LIMIT 1`,
    [session.id],
  );
  const [energyRows] = await pool.query<RowDataPacket[]>(
    "SELECT COALESCE(SUM(power_mw * interval_seconds / 3600000), 0) AS energy_wh FROM measurements WHERE session_id = ?",
    [session.id],
  );
  const [deviceRows] = await pool.query<RowDataPacket[]>(
    `SELECT device_id, status, last_seen_at,
            last_seen_at >= DATE_SUB(NOW(), INTERVAL ? SECOND) AS recently_seen
       FROM device_status ORDER BY last_seen_at DESC LIMIT 1`,
    [session.interval_seconds * 3],
  );
  const device = deviceRows[0] ?? null;
  response.json({
    session,
    latest: latestRows[0] ?? null,
    energy_wh: Number(energyRows[0]?.energy_wh ?? 0),
    device: device ? { ...device, online: Boolean(device.recently_seen) || device.status === "online" || isMqttConnected() } : null,
    data_last_at: latestRows[0]?.timestamp ?? null,
  });
});