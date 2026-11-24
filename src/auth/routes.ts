/**
 * @module auth/routes
 * @layer http
 * @description Login, logout, and reporter check-in endpoints.
 *
 * Logout is intentionally a no-op for short-lived JWTs (MVP): tokens remain
 * valid until `exp`. Add a denylist/refresh store before long-lived tokens.
 */

import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { pool } from '../db/pool.js';
import { AppError } from '../http/errors.js';
import { randomToken, sha256Hex, verifySecret } from './crypto.js';
import { signAccessToken, type Role } from './jwt.js';
import { requireJwt } from './guards.js';
import { writeAudit } from '../audit/log.js';
import { config } from '../config.js';
import { haversineMeters } from '../geo/haversine.js';

export async function authRoutes(app: FastifyInstance) {
  app.post('/auth/login', async (req) => {
    const body = z
      .object({
        email: z.string().email().optional(),
        employeeId: z.string().optional(),
        password: z.string().min(1),
      })
      .safeParse(req.body);
    if (!body.success || (!body.data.email && !body.data.employeeId)) {
      throw new AppError('validation_error', 'email or employeeId and password required');
    }

    const { rows } = await pool.query<{
      id: string;
      role: Role;
      bank_id: string | null;
      display_name: string;
      password_hash: string;
      status: string;
    }>(
      `SELECT id, role, bank_id, display_name, password_hash, status
       FROM users
       WHERE ($1::text IS NOT NULL AND email = $1)
          OR ($2::text IS NOT NULL AND employee_id = $2)
       LIMIT 1`,
      [body.data.email ?? null, body.data.employeeId ?? null],
    );
    const user = rows[0];
    if (!user || user.status !== 'active') {
      await writeAudit(pool, {
        action: 'auth.failure',
        entityType: 'user',
        meta: { reason: 'not_found_or_disabled' },
      });
      throw new AppError('unauthorized', 'Invalid credentials');
    }
    const ok = await verifySecret(user.password_hash, body.data.password);
    if (!ok) {
      await writeAudit(pool, {
        actorUserId: user.id,
        bankId: user.bank_id,
        action: 'auth.failure',
        entityType: 'user',
        entityId: user.id,
      });
      throw new AppError('unauthorized', 'Invalid credentials');
    }

    const token = signAccessToken({
      id: user.id,
      role: user.role,
      bankId: user.bank_id,
    });

    return {
      accessToken: token.accessToken,
      tokenType: 'Bearer' as const,
      expiresIn: token.expiresIn,
      user: {
        id: user.id,
        role: user.role,
        bankId: user.bank_id,
        displayName: user.display_name,
      },
    };
  });

  app.post(
    '/auth/logout',
    { preHandler: [requireJwt] },
    async (_req, reply) => {
      reply.code(204);
      return null;
    },
  );

  app.post('/auth/reporter/check-in', async (req) => {
    const body = z
      .object({
        siteCode: z.string().optional(),
        qrPayload: z.string().optional(),
        employeeId: z.string().min(1),
        pin: z.string().min(1),
        gps: z
          .object({
            lat: z.number(),
            lng: z.number(),
            accuracyMeters: z.number().optional(),
          })
          .optional(),
      })
      .safeParse(req.body);
    if (!body.success || (!body.data.siteCode && !body.data.qrPayload)) {
      throw new AppError(
        'validation_error',
        'siteCode or qrPayload, employeeId, and pin are required',
      );
    }

    const siteRaw = (body.data.siteCode || body.data.qrPayload || '')
      .trim()
      .toUpperCase();

    const atmRes = await pool.query<{
      id: string;
      name: string;
      site_code: string;
      bank_id: string;
      lat: number;
      lng: number;
      bank_name: string;
    }>(
      `SELECT a.id, a.name, a.site_code, a.bank_id, a.lat, a.lng, b.name AS bank_name
       FROM atms a
       JOIN banks b ON b.id = a.bank_id
       WHERE upper(a.site_code) = $1 AND a.retired_at IS NULL`,
      [siteRaw],
    );
    const atm = atmRes.rows[0];
    if (!atm) throw new AppError('unauthorized', 'Invalid site or credentials');

    const userRes = await pool.query<{
      id: string;
      pin_hash: string | null;
      status: string;
      role: string;
    }>(
      `SELECT id, pin_hash, status, role
       FROM users
       WHERE bank_id = $1
         AND employee_id = $2
         AND role = 'queue_reporter'`,
      [atm.bank_id, body.data.employeeId],
    );
    const user = userRes.rows[0];
    if (!user || user.status !== 'active' || !user.pin_hash) {
      await writeAudit(pool, {
        bankId: atm.bank_id,
        action: 'auth.failure',
        entityType: 'reporter',
        meta: { reason: 'user' },
      });
      throw new AppError('unauthorized', 'Invalid site or credentials');
    }
    const pinOk = await verifySecret(user.pin_hash, body.data.pin);
    if (!pinOk) {
      await writeAudit(pool, {
        actorUserId: user.id,
        bankId: atm.bank_id,
        action: 'auth.failure',
        entityType: 'reporter',
        entityId: user.id,
      });
      throw new AppError('unauthorized', 'Invalid site or credentials');
    }

    let gpsWarning = false;
    if (body.data.gps) {
      const dist = haversineMeters(
        body.data.gps.lat,
        body.data.gps.lng,
        atm.lat,
        atm.lng,
      );
      if (dist > config.gpsSoftRadiusM) gpsWarning = true;
      if (
        body.data.gps.accuracyMeters != null &&
        body.data.gps.accuracyMeters > 100
      ) {
        gpsWarning = true;
      }
    }

    const sessionToken = randomToken(32);
    const tokenHash = sha256Hex(sessionToken);
    const expiresAt = new Date(
      Date.now() + config.reporterSessionHours * 3600 * 1000,
    );
    const sessionId = randomUUID();

    // Expire prior sessions (do not DELETE — observations may still reference them).
    await pool.query(
      `UPDATE reporter_sessions SET expires_at = now()
       WHERE user_id = $1 AND expires_at > now()`,
      [user.id],
    );
    // Clear leftover running timers so a new check-in starts with a clean concurrent budget.
    await pool.query(
      `UPDATE service_timer_events
       SET status = 'cancelled', ended_at = now()
       WHERE user_id = $1 AND status = 'running' AND ended_at IS NULL`,
      [user.id],
    );
    await pool.query(
      `INSERT INTO reporter_sessions (id, user_id, atm_id, token_hash, expires_at, gps_warn)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [sessionId, user.id, atm.id, tokenHash, expiresAt.toISOString(), gpsWarning],
    );

    await writeAudit(pool, {
      actorUserId: user.id,
      bankId: atm.bank_id,
      action: 'reporter.check_in',
      entityType: 'atm',
      entityId: atm.id,
      meta: { gpsWarning },
    });

    return {
      sessionToken,
      expiresAt: expiresAt.toISOString(),
      gpsWarning,
      atm: {
        id: atm.id,
        name: atm.name,
        siteCode: atm.site_code,
        bankName: atm.bank_name,
      },
    };
  });
}
