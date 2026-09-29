import "dotenv/config";
import { readFile } from "node:fs/promises";
import mysql, { type Connection, type RowDataPacket } from "mysql2/promise";

const targetDatabase = process.env.MYSQL_DATABASE ?? "mstr";
const legacyDatabase = process.env.LEGACY_MYSQL_DATABASE ?? "mstr_energi";

function databaseIdentifier(value: string): string {
  if (!/^[a-zA-Z0-9_]+$/.test(value)) {
    throw new Error(`Nama database tidak valid: ${value}`);
  }
  return `\`${value}\``;
}

async function tableExists(connection: Connection, database: string, table: string): Promise<boolean> {
  const [rows] = await connection.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS count
       FROM information_schema.tables
      WHERE table_schema = ? AND table_name = ?`,
    [database, table],
  );
  return Number(rows[0]?.count) === 1;
}

async function copyLegacyData(connection: Connection): Promise<void> {
  if (targetDatabase === legacyDatabase) return;
  if (!(await tableExists(connection, legacyDatabase, "substrates"))) return;

  const legacy = databaseIdentifier(legacyDatabase);
  await connection.query(
    `INSERT IGNORE INTO substrates (id, code, name, description, is_active)
     SELECT id, code, name, description, 1 FROM ${legacy}.substrates`,
  );

  if (await tableExists(connection, legacyDatabase, "sessions")) {
    await connection.query(
      `INSERT IGNORE INTO sessions
        (id, substrate_id, replicate, status, started_at, ended_at,
         interval_seconds, ph, temperature_c, volume_ml, voltage_threshold_v, notes)
       SELECT id, substrate_id, replicate, status, started_at, ended_at,
              interval_seconds, ph, temperature_c, volume_ml, voltage_threshold_v, notes
         FROM ${legacy}.sessions`,
    );
  }

  if (await tableExists(connection, legacyDatabase, "measurements")) {
    await connection.query(
      `INSERT IGNORE INTO measurements
        (id, session_id, elapsed_seconds, voltage_v, current_ma, power_mw, created_at)
       SELECT id, session_id, elapsed_seconds, voltage_v, current_ma, power_mw, created_at
         FROM ${legacy}.measurements`,
    );
  }

  if (await tableExists(connection, legacyDatabase, "device_status")) {
    await connection.query(
      `INSERT IGNORE INTO device_status (device_id, status, last_seen_at, updated_at)
       SELECT device_id, status, last_seen_at, updated_at
         FROM ${legacy}.device_status`,
    );
  }
}

async function seedSubstrates(connection: Connection): Promise<void> {
  await connection.query(
    `INSERT IGNORE INTO substrates (code, name, description, is_active) VALUES
      ('KLP', 'Kulit Pisang', 'Ekoenzim berbahan limbah kulit pisang', 1),
      ('KJR', 'Kulit Jeruk', 'Ekoenzim berbahan limbah kulit jeruk', 1),
      ('KMG', 'Kulit Mangga', 'Ekoenzim berbahan limbah kulit mangga', 1)`,
  );
}

async function migrate(): Promise<void> {
  const connection = await mysql.createConnection({
    host: process.env.MYSQL_HOST ?? "localhost",
    port: Number(process.env.MYSQL_PORT ?? 3306),
    user: process.env.MYSQL_USER ?? "root",
    password: process.env.MYSQL_PASSWORD ?? "",
  });

  try {
    await connection.query(
      `CREATE DATABASE IF NOT EXISTS ${databaseIdentifier(targetDatabase)}
       CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci`,
    );
    await connection.query(`USE ${databaseIdentifier(targetDatabase)}`);

    const schema = await readFile(new URL("./schema_mfc.sql", import.meta.url), "utf8");
    const tableStatements = schema
      .replace(/^CREATE DATABASE[\s\S]*?USE mstr;\s*/i, "")
      .split(/;\s*(?=CREATE TABLE)/i)
      .map((statement) => statement.trim())
      .filter(Boolean);

    for (const statement of tableStatements) {
      await connection.query(statement);
    }

    await copyLegacyData(connection);
    await seedSubstrates(connection);
    console.log(`Migrasi database ${targetDatabase} selesai.`);
  } finally {
    await connection.end();
  }
}

migrate().catch((error: unknown) => {
  console.error("Migrasi database gagal:", error);
  process.exitCode = 1;
});