/**
 * @module db/queries/queue
 * @layer query
 * @description Observations and service timer SQL helpers.
 */

import { randomUUID } from 'node:crypto';
import type { DbClient } from '../pool.js';

export async function insertObservation(
  db: DbClient,
  input: {
    atmId: string;
    sessionId: string;
    count: number;
    observedAt: string;
    clientEventId: string;
    remark?: string | null;
  },
) {
  const id = randomUUID();
  await db.query(
    `INSERT INTO queue_observations (
       id, atm_id, source, count, observed_at, session_id, client_event_id, remark
     ) VALUES ($1,$2,'human_report',$3,$4,$5,$6,$7)`,
    [
      id,
      input.atmId,
      input.count,
      input.observedAt,
      input.sessionId,
      input.clientEventId,
      input.remark ?? null,
    ],
  );
  return id;
}

export async function countRunningTimers(
  db: DbClient,
  atmId: string,
  userId: string,
) {
  const { rows } = await db.query<{ c: string }>(
    `SELECT COUNT(*)::text AS c FROM service_timer_events
     WHERE atm_id = $1 AND user_id = $2 AND status = 'running'
       AND ended_at IS NULL`,
    [atmId, userId],
  );
  return Number(rows[0]?.c ?? 0);
}

export async function insertTimerStart(
  db: DbClient,
  input: {
    timerId?: string;
    atmId: string;
    userId: string;
    sessionId: string;
    startedAt: string;
    clientEventId: string;
  },
) {
  const timerId = input.timerId ?? randomUUID();
  await db.query(
    `INSERT INTO service_timer_events (
       id, atm_id, user_id, status, started_at, client_event_id, session_id
     ) VALUES ($1,$2,$3,'running',$4,$5,$6)`,
    [
      timerId,
      input.atmId,
      input.userId,
      input.startedAt,
      input.clientEventId,
      input.sessionId,
    ],
  );
  return timerId;
}

export async function getRunningTimer(
  db: DbClient,
  timerId: string,
  atmId: string,
  userId?: string,
) {
  const params: unknown[] = [timerId, atmId];
  let sql = `SELECT id, status, started_at, duration_sec
             FROM service_timer_events
             WHERE id = $1 AND atm_id = $2 AND ended_at IS NULL`;
  if (userId) {
    params.push(userId);
    sql += ` AND user_id = $3`;
  }
  const { rows } = await db.query<{
    id: string;
    status: string;
    started_at: Date;
    duration_sec: number | null;
  }>(sql, params);
  return rows[0] ?? null;
}

export async function completeTimer(
  db: DbClient,
  timerId: string,
  endedAt: string,
  durationSec: number,
) {
  await db.query(
    `UPDATE service_timer_events
     SET status = 'completed', ended_at = $1, duration_sec = $2
     WHERE id = $3`,
    [endedAt, durationSec, timerId],
  );
}

export async function cancelTimer(
  db: DbClient,
  timerId: string,
  endedAt: string,
) {
  await db.query(
    `UPDATE service_timer_events
     SET status = 'cancelled', ended_at = $1
     WHERE id = $2`,
    [endedAt, timerId],
  );
}
