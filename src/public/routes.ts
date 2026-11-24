/**
 * @module public/routes
 * @layer http
 * @description Anonymous public locate endpoints (allow-listed DTO only).
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from '../db/pool.js';
import { AppError } from '../http/errors.js';
import { config } from '../config.js';
import { PUBLIC_ATM_SELECT_COLS } from '../db/queries/atms.js';
import { mapPublicAtm, type PublicAtmRow } from './mapper.js';
import { waitSummaryFromRow, type WaitSnapshot } from '../wait/engine.js';

const CITIES = [
  { id: 'lilongwe', name: 'Lilongwe', lat: -13.9626, lng: 33.7741 },
  { id: 'blantyre', name: 'Blantyre', lat: -15.7861, lng: 35.0058 },
  { id: 'mzuzu', name: 'Mzuzu', lat: -11.4587, lng: 34.0151 },
  { id: 'zomba', name: 'Zomba', lat: -15.385, lng: 35.3188 },
];

const SELECT_COLS = PUBLIC_ATM_SELECT_COLS;

function waitFromRow(row: PublicAtmRow): WaitSnapshot | null {
  if (row.wait_computed_at == null || row.wait_q == null) return null;
  return waitSummaryFromRow({
    atm_id: row.id,
    q: row.wait_q,
    t_seconds: row.wait_t ?? config.waitDefaultTSec,
    w_minutes: row.wait_w ?? 0,
    congestion: row.wait_congestion ?? 'low',
    source: row.wait_source ?? 'human_report',
    computed_at: row.wait_computed_at,
    observation_at: row.wait_observation_at ?? null,
  });
}

export async function publicRoutes(app: FastifyInstance) {
  app.get('/public/meta/cities', async () => ({ cities: CITIES }));

  app.get('/public/atms/nearby', async (req) => {
    const q = z
      .object({
        lat: z.coerce.number().min(-90).max(90),
        lng: z.coerce.number().min(-180).max(180),
        radius: z.coerce.number().min(100).default(5000),
        limit: z.coerce.number().int().min(1).default(20),
        status: z.string().optional(),
        bank: z.string().optional(),
      })
      .safeParse(req.query);
    if (!q.success) {
      throw new AppError('validation_error', 'Invalid nearby query', {
        issues: q.error.issues,
      });
    }
    const radius = Math.min(q.data.radius, config.nearbyMaxRadiusM);
    const limit = Math.min(q.data.limit, config.nearbyMaxLimit);

    const params: unknown[] = [q.data.lat, q.data.lng, radius, limit];
    let filter = `a.retired_at IS NULL AND b.status = 'active'`;
    if (q.data.status) {
      params.push(q.data.status);
      filter += ` AND a.status = $${params.length}`;
    }
    if (q.data.bank) {
      params.push(q.data.bank);
      filter += ` AND (b.slug = $${params.length} OR b.id::text = $${params.length})`;
    }

    const distExpr = `
      (6371000 * acos(
        least(1.0, greatest(-1.0,
          cos(radians($1)) * cos(radians(a.lat)) * cos(radians(a.lng) - radians($2))
          + sin(radians($1)) * sin(radians(a.lat))
        ))
      ))`;

    const { rows } = await pool.query<PublicAtmRow & { distance_meters: number }>(
      `SELECT ${SELECT_COLS}, ${distExpr} AS distance_meters
       FROM atms a
       JOIN banks b ON b.id = a.bank_id
       LEFT JOIN wait_snapshots w ON w.atm_id = a.id
       WHERE ${filter}
         AND ${distExpr} <= $3
       ORDER BY distance_meters ASC
       LIMIT $4`,
      params,
    );

    return {
      items: rows.map((row) => mapPublicAtm(row, waitFromRow(row))),
    };
  });

  app.get('/public/atms/search', async (req) => {
    const q = z
      .object({
        q: z.string().max(120).optional(),
        bank: z.string().optional(),
        region: z.string().optional(),
        district: z.string().optional(),
        town: z.string().optional(),
        status: z.string().optional(),
        service: z.string().optional(),
        maxWaitMinutes: z.coerce.number().min(0).optional(),
        page: z.coerce.number().int().min(1).default(1),
        pageSize: z.coerce.number().int().min(1).max(50).default(20),
      })
      .safeParse(req.query);
    if (!q.success) {
      throw new AppError('validation_error', 'Invalid search query', {
        issues: q.error.issues,
      });
    }

    const params: unknown[] = [];
    const where: string[] = [`a.retired_at IS NULL`, `b.status = 'active'`];

    if (q.data.q) {
      params.push(`%${q.data.q}%`);
      where.push(
        `(a.name ILIKE $${params.length} OR a.town ILIKE $${params.length} OR a.district ILIKE $${params.length})`,
      );
    }
    if (q.data.bank) {
      params.push(q.data.bank);
      where.push(`(b.slug = $${params.length} OR b.id::text = $${params.length})`);
    }
    if (q.data.region) {
      params.push(q.data.region);
      where.push(`a.region ILIKE $${params.length}`);
    }
    if (q.data.district) {
      params.push(q.data.district);
      where.push(`a.district ILIKE $${params.length}`);
    }
    if (q.data.town) {
      params.push(q.data.town);
      where.push(`a.town ILIKE $${params.length}`);
    }
    if (q.data.status) {
      params.push(q.data.status);
      where.push(`a.status = $${params.length}`);
    }
    if (q.data.service) {
      params.push(q.data.service);
      where.push(
        `EXISTS (SELECT 1 FROM atm_services s WHERE s.atm_id = a.id AND s.service_code = $${params.length} AND s.available)`,
      );
    }

    const whereSql = where.join(' AND ');
    const countRes = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM atms a JOIN banks b ON b.id = a.bank_id
       WHERE ${whereSql}`,
      params,
    );
    const total = Number(countRes.rows[0]?.count ?? 0);
    const offset = (q.data.page - 1) * q.data.pageSize;
    const listParams = [...params, q.data.pageSize, offset];

    const { rows } = await pool.query<PublicAtmRow>(
      `SELECT ${SELECT_COLS}
       FROM atms a
       JOIN banks b ON b.id = a.bank_id
       LEFT JOIN wait_snapshots w ON w.atm_id = a.id
       WHERE ${whereSql}
       ORDER BY a.name ASC
       LIMIT $${listParams.length - 1} OFFSET $${listParams.length}`,
      listParams,
    );

    let items = rows.map((row) => mapPublicAtm(row, waitFromRow(row)));
    if (q.data.maxWaitMinutes != null) {
      const max = q.data.maxWaitMinutes;
      items = items.filter((i) => i.waitMinutes != null && i.waitMinutes <= max);
    }

    return {
      items,
      page: q.data.page,
      pageSize: q.data.pageSize,
      total,
    };
  });

  app.get('/public/atms/:publicId', async (req) => {
    const params = z
      .object({ publicId: z.string().min(1) })
      .safeParse(req.params);
    if (!params.success) {
      throw new AppError('validation_error', 'Invalid ATM id');
    }
    const { rows } = await pool.query<PublicAtmRow>(
      `SELECT ${SELECT_COLS}
       FROM atms a
       JOIN banks b ON b.id = a.bank_id
       LEFT JOIN wait_snapshots w ON w.atm_id = a.id
       WHERE a.id = $1 AND a.retired_at IS NULL AND b.status = 'active'`,
      [params.data.publicId],
    );
    const row = rows[0];
    if (!row) throw new AppError('not_found', 'ATM not found');
    return mapPublicAtm(row, waitFromRow(row));
  });
}
