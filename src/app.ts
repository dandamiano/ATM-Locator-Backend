/**
 * @module app
 * @layer http
 * @description Fastify composition root. Middleware order:
 * request-id → rate-limit → auth → role/tenant → handler.
 *
 * Layers: http (routes) → services → db/queries → PostgreSQL.
 * Domain: wait/engine, public/mapper. Tenancy: tenancy/assert.
 */

import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { join } from 'node:path';
import { AppError, errorBody } from './http/errors.js';
import { registerRequestId } from './http/request-id.js';
import { applyRetryAfter, registerPublicRateLimit } from './ratelimit/public.js';
import { publicRoutes } from './public/routes.js';
import { authRoutes } from './auth/routes.js';
import { bankRoutes } from './banks/routes.js';
import { queueRoutes } from './queue/routes.js';
import { platformRoutes } from './platform/routes.js';
import { integrationRoutes } from './integrations/routes.js';
import { reportRoutes } from './reports/routes.js';
import { config } from './config.js';

export async function buildApp() {
  const app = Fastify({
    logger: !config.isTest,
    trustProxy: true,
  });

  const corsOrigin = config.corsOrigin
    ? config.corsOrigin.split(',').map((s) => s.trim()).filter(Boolean)
    : true;
  await app.register(cors, { origin: corsOrigin });
  await app.register(multipart, { limits: { fileSize: 2 * 1024 * 1024 } });
  await app.register(fastifyStatic, {
    root: join(process.cwd(), config.objectStoreDir),
    prefix: '/files/',
    decorateReply: false,
  });

  await registerRequestId(app);
  await registerPublicRateLimit(app);

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) {
      applyRetryAfter(reply, err);
      return reply.status(err.statusCode).send(errorBody(err));
    }
    const anyErr = err as { validation?: unknown; message?: string };
    if (anyErr.validation) {
      return reply.status(400).send({
        error: {
          code: 'validation_error',
          message: anyErr.message ?? 'Validation error',
        },
      });
    }
    app.log.error(err);
    return reply.status(500).send({
      error: {
        code: 'internal_error',
        message: 'Internal server error',
      },
    });
  });

  await app.register(
    async (api) => {
      api.get('/', async () => ({
        name: 'ATM Locator Platform API',
        version: '1.0.0',
        basePath: '/api/v1',
        health: '/api/v1/health',
        docs: '/openapi/atm-locator-v1.yaml',
        endpoints: {
          public: [
            'GET /public/meta/cities',
            'GET /public/atms/nearby',
            'GET /public/atms/search',
            'GET /public/atms/{id}',
          ],
          auth: [
            'POST /auth/login',
            'POST /auth/logout',
            'POST /auth/reporter/check-in',
          ],
          bank: ['/bank/profile', '/bank/atms', '/bank/users', '/bank/reports/*'],
          queue: ['/queue/session', '/queue/observations', '/queue/timers', '/queue/sync'],
          platform: ['/platform/banks', '/platform/dashboard', '/platform/audit'],
          integrations: ['PUT /integrations/atms/bulk'],
        },
      }));

      api.get('/health', async () => ({ ok: true }));

      await api.register(publicRoutes);
      await api.register(authRoutes);
      await api.register(bankRoutes);
      await api.register(queueRoutes);
      await api.register(platformRoutes);
      await api.register(integrationRoutes);
      await api.register(reportRoutes);
    },
    { prefix: '/api/v1' },
  );

  return app;
}
