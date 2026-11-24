/**
 * @module ratelimit/public
 * @layer infra
 * @description In-process public rate limit (single node).
 * Wire REDIS_URL for multi-instance deployments.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { AppError } from '../http/errors.js';
import { writeAudit } from '../audit/log.js';
import { pool } from '../db/pool.js';

type Bucket = { count: number; resetAt: number };

/** Process-local buckets — not shared across API nodes. */
const buckets = new Map<string, Bucket>();

function clientKey(req: FastifyRequest): string {
  const appKey = req.headers['x-app-key'];
  const ip = req.ip || 'unknown';
  if (typeof appKey === 'string' && appKey.trim()) {
    return `app:${appKey.trim()}`;
  }
  return `ip:${ip}`;
}

export function checkPublicRateLimit(req: FastifyRequest): void {
  if (!req.url.includes('/public/')) return;
  const key = clientKey(req);
  const now = Date.now();
  const windowMs = config.publicRateLimitWindowSec * 1000;
  let bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    bucket = { count: 0, resetAt: now + windowMs };
    buckets.set(key, bucket);
  }
  bucket.count += 1;
  if (bucket.count > config.publicRateLimitMax) {
    const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
    void writeAudit(pool, {
      action: 'rate_limited',
      entityType: 'public',
      entityId: key,
      meta: { path: req.url },
    }).catch(() => undefined);
    throw new AppError('rate_limited', 'Too many requests', undefined, retryAfter);
  }
}

export function applyRetryAfter(reply: FastifyReply, err: AppError) {
  if (err.code === 'rate_limited' && err.retryAfter) {
    reply.header('Retry-After', err.retryAfter);
  }
}

export async function registerPublicRateLimit(app: FastifyInstance) {
  app.addHook('onRequest', async (req) => {
    if (req.url.startsWith('/api/v1/public/') || req.url.startsWith('/public/')) {
      checkPublicRateLimit(req);
    }
  });
}

/** Test helper */
export function resetRateLimitBuckets() {
  buckets.clear();
}
