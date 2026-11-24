/**
 * @module queue/routes
 * @layer http
 * @description Queue reporter HTTP adapters — session-bound writes via services.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '../http/errors.js';
import { requireReporterSession } from '../auth/guards.js';
import * as queueService from '../services/queue.js';

export async function queueRoutes(app: FastifyInstance) {
  app.get(
    '/queue/session',
    { preHandler: [requireReporterSession] },
    async (req) => {
      const s = req.reporterSession!;
      const atm = await queueService.getSessionView(s);
      return {
        atmId: s.atmId,
        atmName: atm?.name,
        siteCode: atm?.site_code,
        expiresAt: s.expiresAt.toISOString(),
        gpsWarning: s.gpsWarn,
      };
    },
  );

  app.post(
    '/queue/observations',
    { preHandler: [requireReporterSession] },
    async (req) => {
      const body = z
        .object({
          count: z.number().int().min(0).max(500),
          observedAt: z.string().datetime(),
          clientEventId: z.string().uuid(),
          remark: z.string().max(200).optional(),
        })
        .safeParse(req.body);
      if (!body.success) {
        throw new AppError('validation_error', 'Invalid observation', {
          issues: body.error.issues,
        });
      }
      return queueService.submitObservation(req.reporterSession!, body.data);
    },
  );

  app.post(
    '/queue/timers',
    { preHandler: [requireReporterSession] },
    async (req) => {
      const body = z
        .object({
          action: z.enum(['start', 'complete', 'cancel']),
          timerId: z.string().uuid().optional(),
          clientEventId: z.string().uuid(),
          at: z.string().datetime().optional(),
        })
        .safeParse(req.body);
      if (!body.success) {
        throw new AppError('validation_error', 'Invalid timer action', {
          issues: body.error.issues,
        });
      }
      return queueService.timerAction(req.reporterSession!, body.data);
    },
  );

  app.post(
    '/queue/sync',
    { preHandler: [requireReporterSession] },
    async (req) => {
      const body = z
        .object({
          events: z
            .array(
              z.object({
                type: z.enum([
                  'observation',
                  'timer_start',
                  'timer_complete',
                  'timer_cancel',
                ]),
                clientEventId: z.string().uuid(),
                at: z.string().datetime(),
                count: z.number().int().min(0).max(500).optional(),
                timerId: z.string().uuid().optional(),
                remark: z.string().optional(),
              }),
            )
            .max(100),
        })
        .safeParse(req.body);
      if (!body.success) {
        throw new AppError('validation_error', 'Invalid sync payload', {
          issues: body.error.issues,
        });
      }
      return queueService.syncEvents(req.reporterSession!, body.data.events);
    },
  );
}
