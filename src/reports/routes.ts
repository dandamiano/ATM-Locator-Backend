import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from '../db/pool.js';
import {
  requireBankTenant,
  requireJwt,
  requireRoles,
} from '../auth/guards.js';
import { freshnessFromObservationAt } from '../wait/engine.js';
import { config } from '../config.js';

export async function reportRoutes(app: FastifyInstance) {
  const bankAuth = [
    requireJwt,
    requireBankTenant,
    requireRoles('bank_admin', 'bank_operator'),
  ];

  app.get('/bank/reports/fleet-health', { preHandler: bankAuth }, async (req) => {
    const bankId = req.authUser!.bankId!;
    const { rows } = await pool.query<{ status: string; c: string }>(
      `SELECT status, COUNT(*)::text AS c
       FROM atms
       WHERE bank_id = $1 AND retired_at IS NULL
       GROUP BY status`,
      [bankId],
    );
    const byStatus: Record<string, number> = {};
    let total = 0;
    for (const r of rows) {
      const n = Number(r.c);
      byStatus[r.status] = n;
      total += n;
    }

    const staleRes = await pool.query<{ c: string }>(
      `SELECT COUNT(*)::text AS c
       FROM atms a
       LEFT JOIN wait_snapshots w ON w.atm_id = a.id
       WHERE a.bank_id = $1 AND a.retired_at IS NULL
         AND (
           w.observation_at IS NULL
           OR w.observation_at < now() - ($2 || ' seconds')::interval
         )`,
      [bankId, String(config.waitAgingSec)],
    );

    return {
      total,
      byStatus,
      staleCount: Number(staleRes.rows[0]?.c ?? 0),
    };
  });

  app.get(
    '/bank/reports/queue-compliance',
    { preHandler: bankAuth },
    async (req) => {
      z.object({
        from: z.string().datetime().optional(),
        to: z.string().datetime().optional(),
      }).parse(req.query);

      const bankId = req.authUser!.bankId!;
      const { rows } = await pool.query<{
        id: string;
        name: string;
        observation_at: Date | null;
      }>(
        `SELECT a.id, a.name, w.observation_at
         FROM atms a
         LEFT JOIN wait_snapshots w ON w.atm_id = a.id
         WHERE a.bank_id = $1 AND a.retired_at IS NULL
         ORDER BY a.name`,
        [bankId],
      );

      return {
        sites: rows.map((r) => {
          const freshness = freshnessFromObservationAt(r.observation_at);
          let compliance: 'ok' | 'overdue' | 'missing' | 'stale' = 'ok';
          if (!r.observation_at) compliance = 'missing';
          else if (freshness === 'stale') compliance = 'stale';
          else if (freshness === 'aging') compliance = 'overdue';
          return {
            atmId: r.id,
            name: r.name,
            compliance,
            lastObservationAt: r.observation_at
              ? r.observation_at.toISOString()
              : null,
          };
        }),
      };
    },
  );
}
