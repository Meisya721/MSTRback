import { Router } from "express";
import type { ResultSetHeader, RowDataPacket } from "mysql2";
import { pool } from "../config/database.js";

export const substrateRouter = Router();

const MAX_CODE_LENGTH = 10;
const MAX_NAME_LENGTH = 100;
const MAX_DESCRIPTION_LENGTH = 2000;

function textField(value: unknown, field: string, maximum: number): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} wajib diisi`);
  }
  const result = value.trim();
  if (result.length > maximum) throw new Error(`${field} maksimal ${maximum} karakter`);
  return result;
}

function optionalDescription(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.trim().length > MAX_DESCRIPTION_LENGTH) {
    throw new Error(`description maksimal ${MAX_DESCRIPTION_LENGTH} karakter`);
  }
  return value.trim();
}

function activeValue(value: unknown): 0 | 1 {
  if (value === true || value === 1 || value === "1") return 1;
  if (value === false || value === 0 || value === "0") return 0;
  throw new Error("is_active harus bernilai 0 atau 1");
}

substrateRouter.get("/substrates", async (request, response) => {
  const active = request.query.active;
  if (active !== undefined && active !== "0" && active !== "1") {
    response.status(400).json({ error: "active harus bernilai 0 atau 1" });
    return;
  }
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT id, code, name, description, is_active, created_at
       FROM substrates
      WHERE (? IS NULL OR is_active = ?)
      ORDER BY name ASC, id ASC`,
    [active === undefined ? null : Number(active), active === undefined ? null : Number(active)],
  );
  response.json(rows);
});

substrateRouter.post("/substrates", async (request, response) => {
  try {
    const code = textField(request.body.code, "code", MAX_CODE_LENGTH);
    const name = textField(request.body.name, "name", MAX_NAME_LENGTH);
    const description = optionalDescription(request.body.description);
    const [result] = await pool.execute<ResultSetHeader>(
      "INSERT INTO substrates (code, name, description, is_active) VALUES (?, ?, ?, 1)",
      [code, name, description],
    );
    response.status(201).json({ id: result.insertId, code, name, description, is_active: 1 });
  } catch (error) {
    if ((error as { code?: string }).code === "ER_DUP_ENTRY") {
      response.status(409).json({ error: "code substrat sudah digunakan" });
      return;
    }
    response.status(400).json({ error: error instanceof Error ? error.message : "Payload substrat tidak valid" });
  }
});

substrateRouter.put("/substrates/:id", async (request, response) => {
  const id = Number(request.params.id);
  if (!Number.isInteger(id) || id < 1) {
    response.status(400).json({ error: "id substrat tidak valid" });
    return;
  }
  try {
    const [existingRows] = await pool.query<RowDataPacket[]>("SELECT * FROM substrates WHERE id = ?", [id]);
    if (existingRows.length === 0) {
      response.status(404).json({ error: "Substrat tidak ditemukan" });
      return;
    }
    const existing = existingRows[0];
    const code = textField(request.body.code ?? existing.code, "code", MAX_CODE_LENGTH);
    const name = textField(request.body.name ?? existing.name, "name", MAX_NAME_LENGTH);
    const description = request.body.description === undefined
      ? existing.description
      : optionalDescription(request.body.description);
    const isActive = request.body.is_active === undefined
      ? Number(existing.is_active) as 0 | 1
      : activeValue(request.body.is_active);
    await pool.execute(
      "UPDATE substrates SET code = ?, name = ?, description = ?, is_active = ? WHERE id = ?",
      [code, name, description, isActive, id],
    );
    response.json({ id, code, name, description, is_active: isActive });
  } catch (error) {
    if ((error as { code?: string }).code === "ER_DUP_ENTRY") {
      response.status(409).json({ error: "code substrat sudah digunakan" });
      return;
    }
    response.status(400).json({ error: error instanceof Error ? error.message : "Payload substrat tidak valid" });
  }
});

substrateRouter.delete("/substrates/:id", async (request, response) => {
  const id = Number(request.params.id);
  if (!Number.isInteger(id) || id < 1) {
    response.status(400).json({ error: "id substrat tidak valid" });
    return;
  }
  const [countRows] = await pool.query<RowDataPacket[]>(
    "SELECT COUNT(*) AS count FROM sessions WHERE substrate_id = ?",
    [id],
  );
  const sessionCount = Number(countRows[0]?.count ?? 0);
  if (sessionCount > 0) {
    response.status(409).json({ error: `Substrat sudah dipakai di ${sessionCount} sesi, tidak bisa dihapus. Nonaktifkan saja.` });
    return;
  }
  try {
    const [result] = await pool.execute<ResultSetHeader>("DELETE FROM substrates WHERE id = ?", [id]);
    if (result.affectedRows === 0) {
      response.status(404).json({ error: "Substrat tidak ditemukan" });
      return;
    }
    response.status(204).send();
  } catch (error) {
    if ((error as { code?: string }).code === "ER_ROW_IS_REFERENCED_2") {
      const [rows] = await pool.query<RowDataPacket[]>(
        "SELECT COUNT(*) AS count FROM sessions WHERE substrate_id = ?",
        [id],
      );
      const count = Number(rows[0]?.count ?? 0);
      response.status(409).json({ error: `Substrat sudah dipakai di ${count} sesi, tidak bisa dihapus. Nonaktifkan saja.` });
      return;
    }
    throw error;
  }
});