/**
 * @module config
 * @layer infra
 * @description Environment configuration. Boot fails without JWT_SECRET.
 */

import 'dotenv/config';

function required(name: string, minLen = 1): string {
  const v = process.env[name];
  if (!v || v.trim().length < minLen) {
    throw new Error(`Missing or invalid required env: ${name}`);
  }
  return v.trim();
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`Invalid number env: ${name}`);
  return n;
}

const isTest = process.env.NODE_ENV === 'test' || process.env.VITEST === 'true';

const jwtSecret =
  process.env.JWT_SECRET?.trim() ||
  (isTest ? 'test-only-jwt-secret-at-least-32-bytes!!' : undefined);

if (!jwtSecret || jwtSecret.length < 32) {
  throw new Error('JWT_SECRET is required and must be at least 32 characters');
}

export const config = {
  isTest,
  port: intEnv('PORT', 3847),
  host: process.env.HOST?.trim() || '127.0.0.1',
  databaseUrl:
    process.env.DATABASE_URL?.trim() ||
    (isTest
      ? 'postgres://postgres:postgres@127.0.0.1:5433/atm_locator'
      : required('DATABASE_URL')),
  jwtSecret,
  jwtExpiresSec: intEnv('JWT_EXPIRES_SEC', 8 * 3600),
  waitFreshSec: intEnv('WAIT_FRESH_SEC', 120),
  waitAgingSec: intEnv('WAIT_AGING_SEC', 300),
  waitDefaultTSec: intEnv('WAIT_DEFAULT_T_SEC', 90),
  gpsSoftRadiusM: intEnv('GPS_SOFT_RADIUS_M', 250),
  reporterSessionHours: intEnv('REPORTER_SESSION_HOURS', 8),
  publicRateLimitMax: intEnv('PUBLIC_RATE_LIMIT_MAX', 120),
  publicRateLimitWindowSec: intEnv('PUBLIC_RATE_LIMIT_WINDOW_SEC', 60),
  objectStoreDir: process.env.OBJECT_STORE_DIR?.trim() || './storage',
  publicBaseUrl: process.env.PUBLIC_BASE_URL?.trim() || 'http://127.0.0.1:3847',
  redisUrl: process.env.REDIS_URL?.trim() || null,
  /** Comma-separated origins; empty = reflect request origin (dev). */
  corsOrigin: process.env.CORS_ORIGIN?.trim() || '',
  nearbyMaxRadiusM: 15000,
  nearbyMaxLimit: 50,
} as const;
