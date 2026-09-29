import type { RowDataPacket } from "mysql2";
import { pool } from "../config/database.js";

export interface SessionReading {
  elapsed_seconds: number;
  voltage_v: number;
  current_ma: number;
  power_mw: number;
  created_at?: string | Date;
}

function average(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function metric(values: number[]) {
  return {
    max: Math.max(...values),
    average: average(values),
    min: Math.min(...values),
  };
}

export function calculateSessionStats(
  readings: SessionReading[],
  anodeAreaCm2: number | null,
  voltageThresholdV: number,
) {
  if (readings.length === 0) {
    return {
      voltage: null,
      current: null,
      power: null,
      energy_cumulative_mwh: 0,
      energy_cumulative_joule: 0,
      peak_power_density_mw_m2: null,
      peak_current_density_ma_m2: null,
      duration_seconds: 0,
      duration_voltage_above_threshold_seconds: 0,
      peak_power_elapsed_seconds: null,
    };
  }

  const voltages = readings.map((reading) => reading.voltage_v);
  const currents = readings.map((reading) => reading.current_ma);
  const powers = readings.map((reading) => reading.power_mw);
  let energyMwh = 0;
  let durationAboveThreshold = 0;

  for (let index = 1; index < readings.length; index += 1) {
    const previous = readings[index - 1];
    const current = readings[index];
    const deltaSeconds = current.elapsed_seconds - previous.elapsed_seconds;
    if (deltaSeconds <= 0) continue;

    energyMwh += ((previous.power_mw + current.power_mw) / 2) * deltaSeconds / 3600;
    if (previous.voltage_v >= voltageThresholdV && current.voltage_v >= voltageThresholdV) {
      durationAboveThreshold += deltaSeconds;
    } else if (previous.voltage_v < voltageThresholdV && current.voltage_v < voltageThresholdV) {
      continue;
    } else {
      const fraction = Math.abs((voltageThresholdV - previous.voltage_v)
        / (current.voltage_v - previous.voltage_v));
      durationAboveThreshold += current.voltage_v >= voltageThresholdV
        ? deltaSeconds * (1 - fraction)
        : deltaSeconds * fraction;
    }
  }

  const peakPower = Math.max(...powers);
  const peakIndex = powers.indexOf(peakPower);
  const areaM2 = anodeAreaCm2 === null ? null : anodeAreaCm2 / 10000;

  return {
    voltage: metric(voltages),
    current: metric(currents),
    power: metric(powers),
    energy_cumulative_mwh: energyMwh,
    energy_cumulative_joule: energyMwh * 3.6,
    peak_power_density_mw_m2: areaM2 && areaM2 > 0 ? peakPower / areaM2 : null,
    peak_current_density_ma_m2: areaM2 && areaM2 > 0 ? Math.max(...currents) / areaM2 : null,
    duration_seconds: readings[readings.length - 1].elapsed_seconds - readings[0].elapsed_seconds,
    duration_voltage_above_threshold_seconds: durationAboveThreshold,
    peak_power_elapsed_seconds: readings[peakIndex].elapsed_seconds,
  };
}

export function downsampleReadings(readings: SessionReading[], maxPoints: number): SessionReading[] {
  if (readings.length <= maxPoints) return readings;
  const firstTime = readings[0].elapsed_seconds;
  const lastTime = readings[readings.length - 1].elapsed_seconds;
  const timeSpan = Math.max(lastTime - firstTime, 1);
  const buckets = new Map<number, SessionReading[]>();

  for (const reading of readings) {
    const bucket = Math.min(
      maxPoints - 1,
      Math.floor(((reading.elapsed_seconds - firstTime) / timeSpan) * maxPoints),
    );
    const bucketReadings = buckets.get(bucket) ?? [];
    bucketReadings.push(reading);
    buckets.set(bucket, bucketReadings);
  }

  return [...buckets.entries()].sort(([left], [right]) => left - right).map(([, bucketReadings]) => ({
    elapsed_seconds: bucketReadings[Math.floor(bucketReadings.length / 2)].elapsed_seconds,
    voltage_v: average(bucketReadings.map((reading) => reading.voltage_v)),
    current_ma: average(bucketReadings.map((reading) => reading.current_ma)),
    power_mw: average(bucketReadings.map((reading) => reading.power_mw)),
    created_at: bucketReadings[bucketReadings.length - 1].created_at,
  }));
}

export async function getSessionReadings(sessionId: number): Promise<SessionReading[]> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT elapsed_seconds, voltage_v, current_ma, power_mw, created_at
       FROM measurements
      WHERE session_id = ?
      ORDER BY elapsed_seconds ASC, id ASC`,
    [sessionId],
  );
  return rows.map((row) => ({
    elapsed_seconds: Number(row.elapsed_seconds),
    voltage_v: Number(row.voltage_v),
    current_ma: Number(row.current_ma),
    power_mw: Number(row.power_mw),
    created_at: row.created_at,
  }));
}