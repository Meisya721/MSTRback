import mysql, { type Pool, type RowDataPacket } from "mysql2/promise";
import { env } from "./env.js";
import type { Telemetry } from "../types/telemetry.js";

export const pool: Pool = mysql.createPool({
  ...env.mysql,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});

export async function checkDatabase(): Promise<boolean> {
  try {
    await pool.query("SELECT 1");
    return true;
  } catch {
    return false;
  }
}

export async function saveTelemetry(data: Telemetry): Promise<void> {
  await pool.execute(
    `INSERT INTO measurements
      (session_id, elapsed_seconds, voltage_v, current_ma, power_mw)
     VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       voltage_v = VALUES(voltage_v),
       current_ma = VALUES(current_ma),
       power_mw = VALUES(power_mw)`,
    [data.sessionId, data.elapsedSeconds, data.voltageV, data.currentMa, data.powerMw],
  );
}

export async function isRunningSession(sessionId: number): Promise<boolean> {
  const [rows] = await pool.query<RowDataPacket[]>(
    "SELECT id FROM sessions WHERE id = ? AND status = 'running' LIMIT 1",
    [sessionId],
  );
  return rows.length > 0;
}

export async function updateDeviceStatus(
  deviceId: string,
  status: "online" | "offline",
): Promise<void> {
  await pool.execute(
    `INSERT INTO device_status (device_id, status, last_seen_at)
     VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE
       status = VALUES(status),
       last_seen_at = VALUES(last_seen_at)`,
    [deviceId, status, new Date()],
  );
}

export async function touchDevice(deviceId: string): Promise<void> {
  await pool.execute(
    `INSERT INTO device_status (device_id, status, last_seen_at)
     VALUES (?, 'online', ?)
     ON DUPLICATE KEY UPDATE
       last_seen_at = VALUES(last_seen_at),
       status = 'online'`,
    [deviceId, new Date()],
  );
}