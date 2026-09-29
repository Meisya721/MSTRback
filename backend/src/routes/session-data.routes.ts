import { Router } from "express";
import type { RowDataPacket } from "mysql2";
import { pool } from "../config/database.js";
import {
  calculateSessionStats,
  downsampleReadings,
  getSessionReadings,
} from "../services/session-stats.js";

export const sessionDataRouter = Router();

function sessionIdFrom(value: string): number | null {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

async function getSession(sessionId: number): Promise<RowDataPacket | null> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT s.*, sub.code AS substrate_code, sub.name AS substrate_name
       FROM sessions s JOIN substrates sub ON sub.id = s.substrate_id
      WHERE s.id = ?`,
    [sessionId],
  );
  return rows[0] ?? null;
}

function maxPointsFrom(value: unknown): number {
  const maxPoints = value === undefined ? 2000 : Number(value);
  if (!Number.isInteger(maxPoints) || maxPoints < 1 || maxPoints > 2000) {
    throw new Error("max_points harus berupa bilangan bulat antara 1 dan 2000");
  }
  return maxPoints;
}

sessionDataRouter.get("/sessions/:id/readings", async (request, response) => {
  const sessionId = sessionIdFrom(request.params.id);
  if (sessionId === null) {
    response.status(400).json({ error: "id sesi tidak valid" });
    return;
  }
  try {
    const session = await getSession(sessionId);
    if (!session) {
      response.status(404).json({ error: "Sesi tidak ditemukan" });
      return;
    }
    const readings = await getSessionReadings(sessionId);
    const maxPoints = maxPointsFrom(request.query.max_points);
    const points = downsampleReadings(readings, maxPoints);
    response.json({ session_id: sessionId, total_points: readings.length, downsampled: points.length < readings.length, points });
  } catch (error) {
    response.status(400).json({ error: error instanceof Error ? error.message : "Parameter readings tidak valid" });
  }
});

sessionDataRouter.get("/compare", async (request, response) => {
  const rawIds = typeof request.query.sessions === "string" ? request.query.sessions.split(",") : [];
  if (rawIds.length < 1 || rawIds.length > 6) {
    response.status(400).json({ error: "sessions wajib berisi 1 sampai 6 id sesi" });
    return;
  }
  const sessionIds = rawIds.map(sessionIdFrom);
  if (sessionIds.some((id) => id === null) || new Set(sessionIds).size !== sessionIds.length) {
    response.status(400).json({ error: "sessions berisi id yang tidak valid atau duplikat" });
    return;
  }
  const results = [];
  for (const sessionId of sessionIds as number[]) {
    const session = await getSession(sessionId);
    if (!session) {
      response.status(404).json({ error: `Sesi ${sessionId} tidak ditemukan` });
      return;
    }
    const readings = await getSessionReadings(sessionId);
    results.push({
      session_id: sessionId,
      substrate_id: session.substrate_id,
      substrate_name: session.substrate_name,
      replicate: session.replicate,
      readings: readings.map(({ elapsed_seconds, voltage_v, current_ma, power_mw }) => ({
        elapsed_seconds,
        voltage_v,
        current_ma,
        power_mw,
      })),
      stats: calculateSessionStats(
        readings,
        session.anode_area_cm2 === null ? null : Number(session.anode_area_cm2),
        Number(session.voltage_threshold_v),
      ),
    });
  }
  response.json({ sessions: results });
});

sessionDataRouter.get("/sessions/:id/export.csv", async (request, response) => {
  const sessionId = sessionIdFrom(request.params.id);
  if (sessionId === null) {
    response.status(400).json({ error: "id sesi tidak valid" });
    return;
  }
  const session = await getSession(sessionId);
  if (!session) {
    response.status(404).json({ error: "Sesi tidak ditemukan" });
    return;
  }
  const readings = await getSessionReadings(sessionId);
  const csvCell = (value: unknown): string => {
    const text = String(value ?? "");
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const metadata = [
    `# session_id: ${session.id}`,
    `# substrate: ${session.substrate_name ?? ""}`,
    `# substrate_id: ${session.substrate_id}`,
    `# replicate: ${session.replicate}`,
    `# status: ${session.status}`,
    `# started_at: ${session.started_at?.toISOString?.() ?? session.started_at ?? ""}`,
  ];
  const lines = [
    ...metadata,
    "elapsed_seconds,waktu,voltage_v,current_ma,power_mw",
    ...readings.map((reading) => [
      reading.elapsed_seconds,
      reading.created_at instanceof Date ? reading.created_at.toISOString() : reading.created_at ?? "",
      reading.voltage_v,
      reading.current_ma,
      reading.power_mw,
    ].map(csvCell).join(",")),
  ];
  response
    .status(200)
    .type("text/csv")
    .set("Content-Disposition", `attachment; filename="session-${sessionId}.csv"`)
    .send(`${lines.join("\n")}\n`);
});