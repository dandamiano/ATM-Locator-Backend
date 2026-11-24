import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';

declare module 'fastify' {
  interface FastifyRequest {
    requestId: string;
  }
}

export async function registerRequestId(app: FastifyInstance) {
  app.addHook('onRequest', async (req, reply) => {
    const incoming = req.headers['x-request-id'];
    const id =
      typeof incoming === 'string' && incoming.trim()
        ? incoming.trim()
        : randomUUID();
    req.requestId = id;
    reply.header('X-Request-Id', id);
  });
}
