import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { pool } from '../db/pool.js';
import { AppError } from '../http/errors.js';
import { requireApiKey } from '../auth/guards.js';
import { replaceBrands, replaceServices } from '../atms/helpers.js';

const AtmStatus = z.enum([
  'operational',
  'out_of_cash',
  'out_of_service',
  'maintenance',
  'temporarily_unavailable',
  'unknown',
]);

export async function integrationRoutes(app: FastifyInstance) {
  app.put(
    '/integrations/atms/bulk',
    { preHandler: [requireApiKey] },
    async (req) => {
      if (!req.apiKeyBank?.scopes.includes('atms:write')) {
        throw new AppError('forbidden', 'API key missing atms:write scope');
      }
      const body = z
        .object({
          atms: z
            .array(
              z.object({
                externalId: z.string().min(1),
                siteCode: z.string().optional(),
                name: z.string().min(1),
                region: z.string().optional(),
                district: z.string().optional(),
                town: z.string().optional(),
                lat: z.number(),
                lng: z.number(),
                status: AtmStatus,
                services: z.record(z.string(), z.boolean()).optional(),
                cardBrands: z.record(z.string(), z.boolean()).optional(),
              }),
            )
            .max(500),
        })
        .safeParse(req.body);
      if (!body.success) {
        throw new AppError('validation_error', 'Invalid bulk payload', {
          issues: body.error.issues,
        });
      }

      const bankId = req.apiKeyBank.bankId;
      let created = 0;
      let updated = 0;
      let skipped = 0;
      const errors: Array<{ externalId: string; message: string }> = [];

      for (const item of body.data.atms) {
        try {
          const existing = await pool.query<{ id: string }>(
            `SELECT id FROM atms WHERE bank_id = $1 AND external_id = $2`,
            [bankId, item.externalId],
          );
          if (existing.rows[0]) {
            const id = existing.rows[0].id;
            await pool.query(
              `UPDATE atms SET
                 name = $1,
                 region = COALESCE($2, region),
                 district = COALESCE($3, district),
                 town = COALESCE($4, town),
                 lat = $5,
                 lng = $6,
                 status = $7,
                 site_code = COALESCE($8, site_code),
                 updated_at = now()
               WHERE id = $9 AND bank_id = $10`,
              [
                item.name,
                item.region ?? null,
                item.district ?? null,
                item.town ?? null,
                item.lat,
                item.lng,
                item.status,
                item.siteCode ? item.siteCode.toUpperCase() : null,
                id,
                bankId,
              ],
            );
            if (item.services) await replaceServices(pool, id, item.services);
            if (item.cardBrands) await replaceBrands(pool, id, item.cardBrands);
            updated += 1;
          } else {
            const siteCode =
              (item.siteCode || `EXT-${item.externalId}`).toUpperCase();
            const id = randomUUID();
            await pool.query(
              `INSERT INTO atms (
                 id, bank_id, site_code, name, region, district, town, lat, lng, status, active_lanes, external_id
               ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,1,$11)`,
              [
                id,
                bankId,
                siteCode,
                item.name,
                item.region ?? '',
                item.district ?? '',
                item.town ?? '',
                item.lat,
                item.lng,
                item.status,
                item.externalId,
              ],
            );
            if (item.services) await replaceServices(pool, id, item.services);
            if (item.cardBrands) await replaceBrands(pool, id, item.cardBrands);
            created += 1;
          }
        } catch (err) {
          errors.push({
            externalId: item.externalId,
            message: err instanceof Error ? err.message : 'upsert_failed',
          });
          skipped += 1;
        }
      }

      return { created, updated, skipped, errors };
    },
  );
}
