/**
 * @module banks/routes
 * @layer http
 * @description Bank portal HTTP adapters — validate, authorize, call services.
 */

import type { FastifyInstance } from 'fastify';
import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import PDFDocument from 'pdfkit';
import { z } from 'zod';
import { AppError } from '../http/errors.js';
import {
  requireBankTenant,
  requireJwt,
  requireRoles,
} from '../auth/guards.js';
import { config } from '../config.js';
import { requireBankId } from '../tenancy/assert.js';
import * as bankService from '../services/banks.js';
import * as atmService from '../services/atms.js';
import * as userService from '../services/users.js';

export async function bankRoutes(app: FastifyInstance) {
  const bankAuth = [requireJwt, requireBankTenant];

  app.get(
    '/bank/profile',
    { preHandler: [...bankAuth, requireRoles('bank_admin', 'bank_operator')] },
    async (req) => bankService.getProfile(requireBankId(req.authUser!)),
  );

  app.patch(
    '/bank/profile',
    { preHandler: [...bankAuth, requireRoles('bank_admin')] },
    async (req) => {
      const body = z.object({ name: z.string().min(1).optional() }).safeParse(req.body);
      if (!body.success) throw new AppError('validation_error', 'Invalid body');
      return bankService.patchProfile(requireBankId(req.authUser!), body.data.name);
    },
  );

  app.post(
    '/bank/logo',
    { preHandler: [...bankAuth, requireRoles('bank_admin')] },
    async (req) => {
      const file = await req.file();
      if (!file) throw new AppError('validation_error', 'file required');
      const bankId = requireBankId(req.authUser!);
      const ext = file.filename.includes('.')
        ? file.filename.split('.').pop()
        : 'png';
      const key = `logos/${bankId}.${ext}`;
      await mkdir(join(config.objectStoreDir, 'logos'), { recursive: true });
      await pipeline(file.file, createWriteStream(join(config.objectStoreDir, key)));
      return bankService.setLogoObjectKey(bankId, key);
    },
  );

  app.get(
    '/bank/users',
    { preHandler: [...bankAuth, requireRoles('bank_admin', 'bank_operator')] },
    async (req) => userService.listUsers(requireBankId(req.authUser!)),
  );

  app.post(
    '/bank/users',
    { preHandler: [...bankAuth, requireRoles('bank_admin')] },
    async (req, reply) => {
      const body = z
        .object({
          email: z.string().email().optional(),
          employeeId: z.string().optional(),
          displayName: z.string().optional(),
          role: z.enum(['bank_admin', 'bank_operator', 'queue_reporter']),
          password: z.string().min(8),
          pin: z.string().optional(),
        })
        .safeParse(req.body);
      if (!body.success) {
        throw new AppError('validation_error', 'Invalid user payload', {
          issues: body.error.issues,
        });
      }
      const created = await userService.createUser(
        requireBankId(req.authUser!),
        body.data,
      );
      reply.code(201);
      return created;
    },
  );

  app.get(
    '/bank/users/:userId',
    { preHandler: [...bankAuth, requireRoles('bank_admin', 'bank_operator')] },
    async (req) => {
      const { userId } = req.params as { userId: string };
      return userService.getUser(requireBankId(req.authUser!), userId);
    },
  );

  app.patch(
    '/bank/users/:userId',
    { preHandler: [...bankAuth, requireRoles('bank_admin')] },
    async (req) => {
      const { userId } = req.params as { userId: string };
      const body = z
        .object({
          displayName: z.string().optional(),
          role: z.enum(['bank_admin', 'bank_operator', 'queue_reporter']).optional(),
          status: z.enum(['active', 'disabled']).optional(),
          password: z.string().min(8).optional(),
          pin: z.string().optional(),
        })
        .safeParse(req.body);
      if (!body.success) throw new AppError('validation_error', 'Invalid patch');
      return userService.patchUser(requireBankId(req.authUser!), userId, body.data);
    },
  );

  app.delete(
    '/bank/users/:userId',
    { preHandler: [...bankAuth, requireRoles('bank_admin')] },
    async (req, reply) => {
      const { userId } = req.params as { userId: string };
      await userService.deactivateUser(requireBankId(req.authUser!), userId);
      reply.code(204);
      return null;
    },
  );

  app.get(
    '/bank/atms',
    { preHandler: [...bankAuth, requireRoles('bank_admin', 'bank_operator')] },
    async (req) => {
      const q = z
        .object({
          status: z.string().optional(),
          page: z.coerce.number().int().min(1).default(1),
          pageSize: z.coerce.number().int().min(1).max(100).default(50),
        })
        .parse(req.query);
      return atmService.listBankAtms({
        bankId: requireBankId(req.authUser!),
        ...q,
      });
    },
  );

  app.post(
    '/bank/atms',
    { preHandler: [...bankAuth, requireRoles('bank_admin')] },
    async (req, reply) => {
      const body = z
        .object({
          siteCode: z.string().min(1),
          name: z.string().min(1),
          region: z.string().default(''),
          district: z.string().default(''),
          town: z.string().default(''),
          lat: z.number(),
          lng: z.number(),
          hours: z.string().optional(),
          status: z.string().default('operational'),
          activeLanes: z.number().int().min(1).default(1),
          services: z.record(z.string(), z.boolean()).optional(),
          cardBrands: z.record(z.string(), z.boolean()).optional(),
        })
        .safeParse(req.body);
      if (!body.success) {
        throw new AppError('validation_error', 'Invalid ATM payload', {
          issues: body.error.issues,
        });
      }
      const created = await atmService.createAtm(
        requireBankId(req.authUser!),
        body.data,
      );
      reply.code(201);
      return created;
    },
  );

  app.get(
    '/bank/atms/:atmId',
    { preHandler: [...bankAuth, requireRoles('bank_admin', 'bank_operator')] },
    async (req) => {
      const { atmId } = req.params as { atmId: string };
      return atmService.getOwnedAtm(requireBankId(req.authUser!), atmId);
    },
  );

  app.patch(
    '/bank/atms/:atmId',
    { preHandler: [...bankAuth, requireRoles('bank_admin', 'bank_operator')] },
    async (req) => {
      const { atmId } = req.params as { atmId: string };
      const body = z
        .object({
          name: z.string().optional(),
          region: z.string().optional(),
          district: z.string().optional(),
          town: z.string().optional(),
          lat: z.number().optional(),
          lng: z.number().optional(),
          hours: z.string().optional(),
          status: z.string().optional(),
          activeLanes: z.number().int().min(1).optional(),
          services: z.record(z.string(), z.boolean()).optional(),
          cardBrands: z.record(z.string(), z.boolean()).optional(),
        })
        .safeParse(req.body);
      if (!body.success) throw new AppError('validation_error', 'Invalid patch');
      return atmService.patchAtm({
        bankId: requireBankId(req.authUser!),
        atmId,
        role: req.authUser!.role,
        body: body.data,
      });
    },
  );

  app.delete(
    '/bank/atms/:atmId',
    { preHandler: [...bankAuth, requireRoles('bank_admin')] },
    async (req, reply) => {
      const { atmId } = req.params as { atmId: string };
      await atmService.retireAtm(requireBankId(req.authUser!), atmId);
      reply.code(204);
      return null;
    },
  );

  app.get(
    '/bank/atms/:atmId/qr.pdf',
    { preHandler: [...bankAuth, requireRoles('bank_admin')] },
    async (req, reply) => {
      const { atmId } = req.params as { atmId: string };
      const atm = await atmService.getAtmQrMeta(
        requireBankId(req.authUser!),
        atmId,
      );
      const doc = new PDFDocument({ size: 'A4', margin: 50 });
      const chunks: Buffer[] = [];
      doc.on('data', (c) => chunks.push(c as Buffer));
      const done = new Promise<Buffer>((resolve) => {
        doc.on('end', () => resolve(Buffer.concat(chunks)));
      });
      doc.fontSize(20).text('ATM Site Code Sheet', { align: 'center' });
      doc.moveDown();
      doc.fontSize(14).text(`Name: ${atm.name}`);
      doc.text(`Site Code: ${atm.site_code}`);
      doc.moveDown();
      doc.fontSize(12).text(
        `Scan / enter site code ${atm.site_code} in the queue reporter app.`,
      );
      doc.end();
      const pdf = await done;
      reply
        .header('Content-Type', 'application/pdf')
        .header(
          'Content-Disposition',
          `attachment; filename="${atm.site_code}.pdf"`,
        )
        .send(pdf);
    },
  );

  app.get(
    '/bank/api-keys',
    { preHandler: [...bankAuth, requireRoles('bank_admin')] },
    async (req) => bankService.listApiKeys(requireBankId(req.authUser!)),
  );

  app.post(
    '/bank/api-keys',
    { preHandler: [...bankAuth, requireRoles('bank_admin')] },
    async (req, reply) => {
      const body = z
        .object({
          label: z.string().optional(),
          scopes: z.array(z.string()).default(['atms:write']),
        })
        .safeParse(req.body ?? {});
      if (!body.success) throw new AppError('validation_error', 'Invalid body');
      const created = await bankService.createApiKey(
        requireBankId(req.authUser!),
        req.authUser!.id,
        body.data,
      );
      reply.code(201);
      return created;
    },
  );

  app.delete(
    '/bank/api-keys/:keyId',
    { preHandler: [...bankAuth, requireRoles('bank_admin')] },
    async (req, reply) => {
      const { keyId } = req.params as { keyId: string };
      await bankService.revokeApiKey(requireBankId(req.authUser!), keyId);
      reply.code(204);
      return null;
    },
  );
}
