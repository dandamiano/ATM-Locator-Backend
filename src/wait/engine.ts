/**
 * @module wait/engine
 * @layer domain
 * @description In-process wait math: W=(Q*T)/N, congestion, freshness at read time.
 */

import type { DbClient } from '../db/pool.js';
import { config } from '../config.js';

export type Congestion = 'low' | 'moderate' | 'high';
export type Freshness = 'fresh' | 'aging' | 'stale';

export type WaitSnapshot = {
  atmId: string;
  queueCount: number;
  waitMinutes: number | null;
  congestion: Congestion | null;
  freshness: Freshness;
  sourceType: string | null;
  computedAt: string;
  observationAt: string | null;
  tSeconds: number;
};

export function congestionFromQ(q: number): Congestion {
  if (q <= 2) return 'low';
  if (q <= 5) return 'moderate';
  return 'high';
}

export function freshnessFromObservationAt(
  observationAt: Date | string | null | undefined,
  now = new Date(),
): Freshness {
  if (!observationAt) return 'stale';
  const at = observationAt instanceof Date ? observationAt : new Date(observationAt);
  if (Number.isNaN(at.getTime())) return 'stale';
  const ageSec = (now.getTime() - at.getTime()) / 1000;
  if (ageSec <= config.waitFreshSec) return 'fresh';
  if (ageSec <= config.waitAgingSec) return 'aging';
  return 'stale';
}

export function computeWaitMinutes(q: number, tSeconds: number, lanes: number): number {
  const n = Math.max(1, lanes);
  const wSeconds = (q * tSeconds) / n;
  return Math.round((wSeconds / 60) * 10) / 10;
}

export async function medianServiceTime(
  db: DbClient,
  atmId: string,
): Promise<number> {
  const { rows } = await db.query<{ duration_sec: number }>(
    `SELECT duration_sec
     FROM service_timer_events
     WHERE atm_id = $1
       AND status = 'completed'
       AND duration_sec IS NOT NULL
       AND duration_sec > 15
       AND duration_sec < 900
     ORDER BY ended_at DESC NULLS LAST, started_at DESC
     LIMIT 20`,
    [atmId],
  );
  if (rows.length === 0) return config.waitDefaultTSec;
  const sorted = rows.map((r) => r.duration_sec).sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
  }
  return sorted[mid]!;
}

export async function recomputeWait(db: DbClient, atmId: string): Promise<WaitSnapshot> {
  const atmRes = await db.query<{ active_lanes: number }>(
    `SELECT active_lanes FROM atms WHERE id = $1`,
    [atmId],
  );
  if (atmRes.rows.length === 0) {
    throw new Error(`ATM not found for wait recompute: ${atmId}`);
  }
  const lanes = atmRes.rows[0]!.active_lanes;

  const obsRes = await db.query<{
    count: number;
    observed_at: Date;
    source: string;
  }>(
    `SELECT count, observed_at, source
     FROM queue_observations
     WHERE atm_id = $1
     ORDER BY observed_at DESC
     LIMIT 1`,
    [atmId],
  );

  const obs = obsRes.rows[0];
  const q = obs?.count ?? 0;
  const tSeconds = await medianServiceTime(db, atmId);
  const wMinutes = computeWaitMinutes(q, tSeconds, lanes);
  const congestion = congestionFromQ(q);
  const observationAt = obs?.observed_at ?? null;
  const freshness = freshnessFromObservationAt(observationAt);
  const source = obs?.source ?? 'human_report';
  const computedAt = new Date();

  await db.query(
    `INSERT INTO wait_snapshots (
       atm_id, q, t_seconds, w_minutes, congestion, freshness, source, computed_at, observation_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (atm_id) DO UPDATE SET
       q = EXCLUDED.q,
       t_seconds = EXCLUDED.t_seconds,
       w_minutes = EXCLUDED.w_minutes,
       congestion = EXCLUDED.congestion,
       freshness = EXCLUDED.freshness,
       source = EXCLUDED.source,
       computed_at = EXCLUDED.computed_at,
       observation_at = EXCLUDED.observation_at`,
    [
      atmId,
      q,
      tSeconds,
      wMinutes,
      congestion,
      freshness,
      source,
      computedAt.toISOString(),
      observationAt,
    ],
  );

  return toPublicWaitSnapshot({
    atmId,
    q,
    tSeconds,
    wMinutes,
    congestion,
    source,
    computedAt,
    observationAt,
  });
}

export function toPublicWaitSnapshot(input: {
  atmId: string;
  q: number;
  tSeconds: number;
  wMinutes: number;
  congestion: Congestion;
  source: string;
  computedAt: Date | string;
  observationAt: Date | string | null;
}): WaitSnapshot {
  const freshness = freshnessFromObservationAt(input.observationAt);
  const live = freshness !== 'stale';
  return {
    atmId: input.atmId,
    queueCount: live ? input.q : 0,
    waitMinutes: live ? input.wMinutes : null,
    congestion: live ? input.congestion : null,
    freshness,
    sourceType: input.source,
    computedAt:
      input.computedAt instanceof Date
        ? input.computedAt.toISOString()
        : input.computedAt,
    observationAt: input.observationAt
      ? input.observationAt instanceof Date
        ? input.observationAt.toISOString()
        : String(input.observationAt)
      : null,
    tSeconds: input.tSeconds,
  };
}

export function waitSummaryFromRow(row: {
  atm_id: string;
  q: number;
  t_seconds: number;
  w_minutes: string | number;
  congestion: string;
  source: string;
  computed_at: Date;
  observation_at: Date | null;
}): WaitSnapshot {
  return toPublicWaitSnapshot({
    atmId: row.atm_id,
    q: row.q,
    tSeconds: row.t_seconds,
    wMinutes: Number(row.w_minutes),
    congestion: row.congestion as Congestion,
    source: row.source,
    computedAt: row.computed_at,
    observationAt: row.observation_at,
  });
}
