/**
 * @module auth/guards
 * @layer http
 * @description Auth preHandlers: JWT, reporter session, API key, RBAC.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
import { pool } from '../db/pool.js';
import { AppError } from '../http/errors.js';
import { assertBankAccess } from '../tenancy/assert.js';
import { sha256Hex } from './crypto.js';
import { verifyAccessToken, type AuthUser, type Role } from './jwt.js';

declare module 'fastify' {
  interface FastifyRequest {
    authUser?: AuthUser;
    reporterSession?: {
      id: string;
      userId: string;
      atmId: string;
      expiresAt: Date;
      gpsWarn: boolean;
    };
    apiKeyBank?: {
      credentialId: string;
      bankId: string;
      scopes: string[];
    };
  }
}

function bearerToken(req: FastifyRequest): string | null {
  const h = req.headers.authorization;
  if (!h || !h.startsWith('Bearer ')) return null;
  return h.slice('Bearer '.length).trim() || null;
}

export async function requireJwt(
  req: FastifyRequest,
  _reply: FastifyReply,
): Promise<void> {
  const token = bearerToken(req);
  if (!token) throw new AppError('unauthorized', 'Missing bearer token');
  req.authUser = verifyAccessToken(token);
}

export function requireRoles(...roles: Role[]) {
  return async (req: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    if (!req.authUser) throw new AppError('unauthorized', 'Authentication required');
    if (!roles.includes(req.authUser.role)) {
      throw new AppError('forbidden', 'Insufficient role');
    }
  };
}

export async function requireBankTenant(
  req: FastifyRequest,
  _reply: FastifyReply,
): Promise<void> {
  if (!req.authUser) throw new AppError('unauthorized', 'Authentication required');
  const bankRoles: Role[] = ['bank_admin', 'bank_operator', 'queue_reporter'];
  if (bankRoles.includes(req.authUser.role) && !req.authUser.bankId) {
    throw new AppError('forbidden', 'Bank tenancy required');
  }
}

export async function requireReporterSession(
  req: FastifyRequest,
  _reply: FastifyReply,
): Promise<void> {
  const token = bearerToken(req);
  if (!token) throw new AppError('unauthorized', 'Missing reporter session');
  const hash = sha256Hex(token);
  const { rows } = await pool.query<{
    id: string;
    user_id: string;
    atm_id: string;
    expires_at: Date;
    gps_warn: boolean;
  }>(
    `SELECT id, user_id, atm_id, expires_at, gps_warn
     FROM reporter_sessions
     WHERE token_hash = $1`,
    [hash],
  );
  const row = rows[0];
  if (!row || row.expires_at.getTime() <= Date.now()) {
    throw new AppError('unauthorized', 'Invalid or expired reporter session');
  }
  req.reporterSession = {
    id: row.id,
    userId: row.user_id,
    atmId: row.atm_id,
    expiresAt: row.expires_at,
    gpsWarn: row.gps_warn,
  };
}

export async function requireApiKey(
  req: FastifyRequest,
  _reply: FastifyReply,
): Promise<void> {
  const key = req.headers['x-api-key'];
  if (typeof key !== 'string' || !key.trim()) {
    throw new AppError('unauthorized', 'Missing API key');
  }
  const hash = sha256Hex(key.trim());
  const { rows } = await pool.query<{
    id: string;
    bank_id: string;
    scopes: string[];
    revoked_at: Date | null;
  }>(
    `SELECT id, bank_id, scopes, revoked_at
     FROM api_credentials
     WHERE key_hash = $1`,
    [hash],
  );
  const row = rows[0];
  if (!row || row.revoked_at) {
    throw new AppError('unauthorized', 'Invalid API key');
  }
  req.apiKeyBank = {
    credentialId: row.id,
    bankId: row.bank_id,
    scopes: row.scopes,
  };
}

export function assertTenantOwnsBank(req: FastifyRequest, bankId: string) {
  if (!req.authUser) throw new AppError('unauthorized', 'Authentication required');
  assertBankAccess(req.authUser, bankId);
}
