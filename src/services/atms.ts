/**
 * @module services/atms
 * @layer service
 * @description Bank ATM create/update/retire and QR payload helpers.
 */

import type { Role } from '../auth/jwt.js';
import { AppError } from '../http/errors.js';
import { pool, withTransaction } from '../db/pool.js';
import {
  BANK_ATM_SELECT,
  getBankAtm,
  insertAtm,
  replaceBrands,
  replaceServices,
  toBankAtmDto,
  type BankAtmRow,
} from '../db/queries/atms.js';

export async function listBankAtms(input: {
  bankId: string;
  status?: string;
  page: number;
  pageSize: number;
}) {
  const params: unknown[] = [input.bankId];
  let where = `a.bank_id = $1`;
  if (input.status) {
    params.push(input.status);
    where += ` AND a.status = $${params.length}`;
  }
  const count = await pool.query<{ c: string }>(
    `SELECT COUNT(*)::text AS c FROM atms a WHERE ${where}`,
    params,
  );
  const total = Number(count.rows[0]?.c ?? 0);
  params.push(input.pageSize, (input.page - 1) * input.pageSize);
  const { rows } = await pool.query<BankAtmRow>(
    `${BANK_ATM_SELECT} WHERE ${where} ORDER BY a.name
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  const items = [];
  for (const row of rows) items.push(await toBankAtmDto(pool, row));
  return { items, page: input.page, pageSize: input.pageSize, total };
}

export async function getOwnedAtm(bankId: string, atmId: string) {
  const row = await getBankAtm(pool, atmId, bankId);
  if (!row) throw new AppError('not_found', 'ATM not found');
  return toBankAtmDto(pool, row);
}

/** Creates ATM + optional services/brands in one transaction. */
export async function createAtm(
  bankId: string,
  body: {
    siteCode: string;
    name: string;
    region: string;
    district: string;
    town: string;
    lat: number;
    lng: number;
    hours?: string;
    status: string;
    activeLanes: number;
    services?: Record<string, boolean>;
    cardBrands?: Record<string, boolean>;
  },
) {
  return withTransaction(async (tx) => {
    const id = await insertAtm(tx, { bankId, ...body });
    const row = await getBankAtm(tx, id);
    return toBankAtmDto(tx, row!);
  });
}

export async function patchAtm(input: {
  bankId: string;
  atmId: string;
  role: Role;
  body: {
    name?: string;
    region?: string;
    district?: string;
    town?: string;
    lat?: number;
    lng?: number;
    hours?: string;
    status?: string;
    activeLanes?: number;
    services?: Record<string, boolean>;
    cardBrands?: Record<string, boolean>;
  };
}) {
  const existing = await getBankAtm(pool, input.atmId, input.bankId);
  if (!existing) throw new AppError('not_found', 'ATM not found');

  if (input.role === 'bank_operator') {
    const forbidden = ['name', 'region', 'district', 'town', 'lat', 'lng', 'hours'] as const;
    for (const k of forbidden) {
      if (input.body[k] !== undefined) {
        throw new AppError('forbidden', 'Operator cannot edit ATM master data');
      }
    }
  }

  return withTransaction(async (tx) => {
    const sets: string[] = [`updated_at = now()`];
    const params: unknown[] = [];
    const push = (col: string, val: unknown) => {
      params.push(val);
      sets.push(`${col} = $${params.length}`);
    };
    const b = input.body;
    if (b.name != null) push('name', b.name);
    if (b.region != null) push('region', b.region);
    if (b.district != null) push('district', b.district);
    if (b.town != null) push('town', b.town);
    if (b.lat != null) push('lat', b.lat);
    if (b.lng != null) push('lng', b.lng);
    if (b.hours != null) push('hours_json', JSON.stringify({ summary: b.hours }));
    if (b.status != null) push('status', b.status);
    if (b.activeLanes != null) push('active_lanes', b.activeLanes);

    params.push(input.atmId, input.bankId);
    await tx.query(
      `UPDATE atms SET ${sets.join(', ')}
       WHERE id = $${params.length - 1} AND bank_id = $${params.length}`,
      params,
    );
    if (b.services) await replaceServices(tx, input.atmId, b.services);
    if (b.cardBrands) await replaceBrands(tx, input.atmId, b.cardBrands);

    const row = await getBankAtm(tx, input.atmId);
    return toBankAtmDto(tx, row!);
  });
}

export async function retireAtm(bankId: string, atmId: string) {
  const res = await pool.query(
    `UPDATE atms SET retired_at = now(), updated_at = now()
     WHERE id = $1 AND bank_id = $2 AND retired_at IS NULL`,
    [atmId, bankId],
  );
  if ((res.rowCount ?? 0) === 0) throw new AppError('not_found', 'ATM not found');
}

export async function getAtmQrMeta(bankId: string, atmId: string) {
  const { rows } = await pool.query<{ site_code: string; name: string }>(
    `SELECT site_code, name FROM atms WHERE id = $1 AND bank_id = $2`,
    [atmId, bankId],
  );
  if (!rows[0]) throw new AppError('not_found', 'ATM not found');
  return rows[0];
}
