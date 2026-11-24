/**
 * @module services/queue
 * @layer service
 * @description Queue observations, timers, offline sync, and wait recompute.
 *
 * Idempotency: every client_event_id is recorded in processed_client_events.
 * service_timer_events keeps one row per real timer (start row updated on complete/cancel).
 */

import { AppError } from '../http/errors.js';
import { pool, withTransaction } from '../db/pool.js';
import {
  findProcessedEvent,
  recordProcessedEvent,
} from '../db/queries/client-events.js';
import * as queueQ from '../db/queries/queue.js';
import { recomputeWait, type WaitSnapshot } from '../wait/engine.js';

export type ReporterCtx = {
  id: string;
  userId: string;
  atmId: string;
};

function waitDto(w: WaitSnapshot) {
  return {
    queueCount: w.queueCount,
    waitMinutes: w.waitMinutes,
    congestion: w.congestion,
    freshness: w.freshness,
    sourceType: w.sourceType,
    computedAt: w.computedAt,
    observationAt: w.observationAt,
  };
}

export async function getSessionView(ctx: ReporterCtx) {
  const { rows } = await pool.query<{ name: string; site_code: string }>(
    `SELECT name, site_code FROM atms WHERE id = $1`,
    [ctx.atmId],
  );
  return rows[0] ?? null;
}

export async function submitObservation(
  ctx: ReporterCtx,
  body: {
    count: number;
    observedAt: string;
    clientEventId: string;
    remark?: string;
  },
) {
  const existing = await findProcessedEvent(pool, body.clientEventId);
  if (existing) {
    const wait = await recomputeWait(pool, ctx.atmId);
    return { status: 'duplicate' as const, wait: waitDto(wait) };
  }

  return withTransaction(async (tx) => {
    const again = await findProcessedEvent(tx, body.clientEventId);
    if (again) {
      const wait = await recomputeWait(tx, ctx.atmId);
      return { status: 'duplicate' as const, wait: waitDto(wait) };
    }
    const obsId = await queueQ.insertObservation(tx, {
      atmId: ctx.atmId,
      sessionId: ctx.id,
      count: body.count,
      observedAt: body.observedAt,
      clientEventId: body.clientEventId,
      remark: body.remark,
    });
    await recordProcessedEvent(tx, {
      clientEventId: body.clientEventId,
      atmId: ctx.atmId,
      eventType: 'observation',
      entityId: obsId,
    });
    const wait = await recomputeWait(tx, ctx.atmId);
    return { status: 'accepted' as const, wait: waitDto(wait) };
  });
}

export async function timerAction(
  ctx: ReporterCtx,
  body: {
    action: 'start' | 'complete' | 'cancel';
    timerId?: string;
    clientEventId: string;
    at?: string;
  },
) {
  const at = body.at ?? new Date().toISOString();
  const dup = await findProcessedEvent(pool, body.clientEventId);
  if (dup) {
    return {
      timerId: dup.entity_id ?? body.timerId ?? dup.client_event_id,
      action: body.action,
      status: 'duplicate' as const,
      durationSeconds: null as number | null,
    };
  }

  if (body.action === 'start') {
    return withTransaction(async (tx) => {
      if (await findProcessedEvent(tx, body.clientEventId)) {
        return {
          timerId: body.clientEventId,
          action: 'start' as const,
          status: 'duplicate' as const,
          durationSeconds: null,
        };
      }
      const running = await queueQ.countRunningTimers(tx, ctx.atmId, ctx.userId);
      if (running >= 3) {
        throw new AppError('conflict', 'Too many concurrent timers');
      }
      const timerId = await queueQ.insertTimerStart(tx, {
        atmId: ctx.atmId,
        userId: ctx.userId,
        sessionId: ctx.id,
        startedAt: at,
        clientEventId: body.clientEventId,
      });
      await recordProcessedEvent(tx, {
        clientEventId: body.clientEventId,
        atmId: ctx.atmId,
        eventType: 'timer_start',
        entityId: timerId,
      });
      return {
        timerId,
        action: 'start' as const,
        status: 'running' as const,
        durationSeconds: null,
      };
    });
  }

  if (!body.timerId) {
    throw new AppError('validation_error', 'timerId required for complete/cancel');
  }

  return withTransaction(async (tx) => {
    if (await findProcessedEvent(tx, body.clientEventId)) {
      return {
        timerId: body.timerId!,
        action: body.action,
        status: 'duplicate' as const,
        durationSeconds: null,
      };
    }

    const timer = await queueQ.getRunningTimer(
      tx,
      body.timerId!,
      ctx.atmId,
      ctx.userId,
    );
    if (!timer || timer.status !== 'running') {
      throw new AppError('conflict', 'Timer is not running');
    }

    if (body.action === 'cancel') {
      await queueQ.cancelTimer(tx, timer.id, at);
      await recordProcessedEvent(tx, {
        clientEventId: body.clientEventId,
        atmId: ctx.atmId,
        eventType: 'timer_cancel',
        entityId: timer.id,
      });
      return {
        timerId: timer.id,
        action: 'cancel' as const,
        status: 'cancelled' as const,
        durationSeconds: null,
      };
    }

    const durationSec = Math.max(
      0,
      Math.round((new Date(at).getTime() - timer.started_at.getTime()) / 1000),
    );
    await queueQ.completeTimer(tx, timer.id, at, durationSec);
    await recordProcessedEvent(tx, {
      clientEventId: body.clientEventId,
      atmId: ctx.atmId,
      eventType: 'timer_complete',
      entityId: timer.id,
    });
    const wait = await recomputeWait(tx, ctx.atmId);
    return {
      timerId: timer.id,
      action: 'complete' as const,
      status: 'completed' as const,
      durationSeconds: durationSec,
      wait: waitDto(wait),
    };
  });
}

export async function syncEvents(
  ctx: ReporterCtx,
  events: Array<{
    type: 'observation' | 'timer_start' | 'timer_complete' | 'timer_cancel';
    clientEventId: string;
    at: string;
    count?: number;
    timerId?: string;
    remark?: string;
  }>,
) {
  const accepted: string[] = [];
  const duplicates: string[] = [];
  const rejected: Array<{ clientEventId: string; reason: string }> = [];
  let touched = false;

  for (const ev of events) {
    try {
      if (await findProcessedEvent(pool, ev.clientEventId)) {
        duplicates.push(ev.clientEventId);
        continue;
      }

      if (ev.type === 'observation') {
        if (ev.count == null) {
          rejected.push({ clientEventId: ev.clientEventId, reason: 'count_required' });
          continue;
        }
        await withTransaction(async (tx) => {
          if (await findProcessedEvent(tx, ev.clientEventId)) return;
          const obsId = await queueQ.insertObservation(tx, {
            atmId: ctx.atmId,
            sessionId: ctx.id,
            count: ev.count!,
            observedAt: ev.at,
            clientEventId: ev.clientEventId,
            remark: ev.remark,
          });
          await recordProcessedEvent(tx, {
            clientEventId: ev.clientEventId,
            atmId: ctx.atmId,
            eventType: 'observation',
            entityId: obsId,
          });
          await recomputeWait(tx, ctx.atmId);
        });
        accepted.push(ev.clientEventId);
        touched = true;
        continue;
      }

      if (ev.type === 'timer_start') {
        await withTransaction(async (tx) => {
          if (await findProcessedEvent(tx, ev.clientEventId)) return;
          const running = await queueQ.countRunningTimers(tx, ctx.atmId, ctx.userId);
          if (running >= 3) {
            throw new AppError('conflict', 'too_many_timers');
          }
          const timerId = await queueQ.insertTimerStart(tx, {
            timerId: ev.timerId,
            atmId: ctx.atmId,
            userId: ctx.userId,
            sessionId: ctx.id,
            startedAt: ev.at,
            clientEventId: ev.clientEventId,
          });
          await recordProcessedEvent(tx, {
            clientEventId: ev.clientEventId,
            atmId: ctx.atmId,
            eventType: 'timer_start',
            entityId: timerId,
          });
        });
        accepted.push(ev.clientEventId);
        continue;
      }

      if (!ev.timerId) {
        rejected.push({ clientEventId: ev.clientEventId, reason: 'timer_id_required' });
        continue;
      }

      await withTransaction(async (tx) => {
        if (await findProcessedEvent(tx, ev.clientEventId)) return;
        const timer = await queueQ.getRunningTimer(tx, ev.timerId!, ctx.atmId);
        if (!timer || timer.status !== 'running') {
          throw new AppError('conflict', 'timer_not_running');
        }
        if (ev.type === 'timer_cancel') {
          await queueQ.cancelTimer(tx, timer.id, ev.at);
          await recordProcessedEvent(tx, {
            clientEventId: ev.clientEventId,
            atmId: ctx.atmId,
            eventType: 'timer_cancel',
            entityId: timer.id,
          });
          return;
        }
        const durationSec = Math.max(
          0,
          Math.round((new Date(ev.at).getTime() - timer.started_at.getTime()) / 1000),
        );
        await queueQ.completeTimer(tx, timer.id, ev.at, durationSec);
        await recordProcessedEvent(tx, {
          clientEventId: ev.clientEventId,
          atmId: ctx.atmId,
          eventType: 'timer_complete',
          entityId: timer.id,
        });
        await recomputeWait(tx, ctx.atmId);
        touched = true;
      });
      accepted.push(ev.clientEventId);
    } catch (err) {
      const reason =
        err instanceof AppError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'rejected';
      if (reason === 'too_many_timers' || reason === 'timer_not_running') {
        rejected.push({ clientEventId: ev.clientEventId, reason });
      } else {
        rejected.push({ clientEventId: ev.clientEventId, reason });
      }
    }
  }

  if (touched) {
    // final recompute already done per observation/complete; no-op safety
  }
  return { accepted, duplicates, rejected };
}
