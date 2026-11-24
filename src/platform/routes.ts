import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { pool } from '../db/pool.js';
import { AppError } from '../http/errors.js';
import { requireJwt, requireRoles } from '../auth/guards.js';
import { config } from '../config.js';
import { writeAudit } from '../audit/log.js';

export async function platformRoutes(app: FastifyInstance) {
  const platformAuth = [
    requireJwt,
    requireRoles('platform_admin', 'platform_analyst'),
  ];
  const adminOnly = [requireJwt, requireRoles('platform_admin')];

  app.get('/platform/banks', { preHandler: platformAuth }, async () => {
    const { rows } = await pool.query(
      `SELECT id, name, slug, status, created_at FROM banks ORDER BY name`,
    );
    return {
      banks: rows.map((b) => ({
        id: b.id,
        name: b.name,
        slug: b.slug,
        status: b.status,
        createdAt: b.created_at.toISOString(),
      })),
    };
  });

  app.post('/platform/banks', { preHandler: adminOnly }, async (req, reply) => {
    const body = z
      .object({
        name: z.string().min(1),
        slug: z.string().regex(/^[a-z0-9-]+$/),
      })
      .safeParse(req.body);
    if (!body.success) {
      throw new AppError('validation_error', 'Invalid bank payload');
    }
    const id = randomUUID();
    await pool.query(
      `INSERT INTO banks (id, name, slug, status) VALUES ($1,$2,$3,'active')`,
      [id, body.data.name, body.data.slug],
    );
    await writeAudit(pool, {
      actorUserId: req.authUser!.id,
      bankId: id,
      action: 'bank.created',
      entityType: 'bank',
      entityId: id,
    });
    reply.code(201);
    return {
      id,
      name: body.data.name,
      slug: body.data.slug,
      status: 'active',
      createdAt: new Date().toISOString(),
    };
  });

  app.patch(
    '/platform/banks/:bankId',
    { preHandler: adminOnly },
    async (req) => {
      const { bankId } = req.params as { bankId: string };
      const body = z
        .object({
          name: z.string().optional(),
          status: z.enum(['active', 'suspended']).optional(),
        })
        .safeParse(req.body);
      if (!body.success) throw new AppError('validation_error', 'Invalid patch');

      const sets: string[] = [];
      const params: unknown[] = [];
      if (body.data.name != null) {
        params.push(body.data.name);
        sets.push(`name = $${params.length}`);
      }
      if (body.data.status != null) {
        params.push(body.data.status);
        sets.push(`status = $${params.length}`);
      }
      if (!sets.length) throw new AppError('validation_error', 'No changes');
      params.push(bankId);
      const res = await pool.query(
        `UPDATE banks SET ${sets.join(', ')} WHERE id = $${params.length}
         RETURNING id, name, slug, status, created_at`,
        params,
      );
      const b = res.rows[0];
      if (!b) throw new AppError('not_found', 'Bank not found');
      return {
        id: b.id,
        name: b.name,
        slug: b.slug,
        status: b.status,
        createdAt: b.created_at.toISOString(),
      };
    },
  );

  app.get('/platform/dashboard', { preHandler: platformAuth }, async () => {
    const banks = await pool.query<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM banks`,
    );
    const atms = await pool.query<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM atms WHERE retired_at IS NULL`,
    );
    const byStatusRows = await pool.query<{ status: string; c: string }>(
      `SELECT status, COUNT(*)::text AS c FROM atms WHERE retired_at IS NULL GROUP BY status`,
    );
    const byStatus: Record<string, number> = {};
    for (const r of byStatusRows.rows) byStatus[r.status] = Number(r.c);

    const stale = await pool.query<{ c: string }>(
      `SELECT COUNT(*)::text AS c
       FROM atms a
       LEFT JOIN wait_snapshots w ON w.atm_id = a.id
       WHERE a.retired_at IS NULL
         AND (
           w.observation_at IS NULL
           OR w.observation_at < now() - ($1 || ' seconds')::interval
         )`,
      [String(config.waitAgingSec)],
    );
    const qEvents = await pool.query<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM queue_observations
       WHERE created_at > now() - interval '1 hour'`,
    );

    return {
      bankCount: Number(banks.rows[0]?.c ?? 0),
      atmCount: Number(atms.rows[0]?.c ?? 0),
      byStatus,
      staleAtmCount: Number(stale.rows[0]?.c ?? 0),
      queueEventsLastHour: Number(qEvents.rows[0]?.c ?? 0),
      apiErrorRate: 0,
    };
  });

  app.get('/platform/audit', { preHandler: adminOnly }, async (req) => {
    const q = z
      .object({
        bankId: z.string().uuid().optional(),
        from: z.string().datetime().optional(),
        to: z.string().datetime().optional(),
        page: z.coerce.number().int().min(1).default(1),
        pageSize: z.coerce.number().int().min(1).max(100).default(50),
      })
      .parse(req.query);

    const params: unknown[] = [];
    const where: string[] = ['1=1'];
    if (q.bankId) {
      params.push(q.bankId);
      where.push(`bank_id = $${params.length}`);
    }
    if (q.from) {
      params.push(q.from);
      where.push(`at >= $${params.length}`);
    }
    if (q.to) {
      params.push(q.to);
      where.push(`at <= $${params.length}`);
    }
    const whereSql = where.join(' AND ');
    const count = await pool.query<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM audit_events WHERE ${whereSql}`,
      params,
    );
    const total = Number(count.rows[0]?.c ?? 0);
    params.push(q.pageSize, (q.page - 1) * q.pageSize);
    const { rows } = await pool.query(
      `SELECT id, at, actor_user_id, bank_id, action, entity_type, entity_id, meta_json
       FROM audit_events
       WHERE ${whereSql}
       ORDER BY at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );

    return {
      items: rows.map((r) => ({
        id: r.id,
        at: r.at.toISOString(),
        actorUserId: r.actor_user_id,
        bankId: r.bank_id,
        action: r.action,
        entityType: r.entity_type,
        entityId: r.entity_id,
        meta: r.meta_json,
      })),
      page: q.page,
      pageSize: q.pageSize,
      total,
    };
  });
}
