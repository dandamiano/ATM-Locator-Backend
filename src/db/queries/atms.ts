/**
 * @module db/queries/atms
 * @layer query
 * @description Typed SQL accessors for ATM rows, services, and card brands.
 */

import { randomUUID } from 'node:crypto';
import type { DbClient } from '../pool.js';
import { config } from '../../config.js';
import {
  waitSummaryFromRow,
  type WaitSnapshot,
} from '../../wait/engine.js';

export type BankAtmRow = {
  id: string;
  site_code: string;
  name: string;
  region: string;
  district: string;
  town: string;
  lat: number;
  lng: number;
  hours_json: unknown;
  status: string;
  active_lanes: number;
  retired_at: Date | null;
  wait_q: number | null;
  wait_t: number | null;
  wait_w: string | number | null;
  wait_congestion: string | null;
  wait_source: string | null;
  wait_computed_at: Date | null;
  wait_observation_at: Date | null;
  wait_freshness: string | null;
};

/** Shared SELECT for bank ATM views (includes wait snapshot join). */
export const BANK_ATM_SELECT = `
  SELECT a.id, a.site_code, a.name, a.region, a.district, a.town,
         a.lat, a.lng, a.hours_json, a.status, a.active_lanes, a.retired_at,
         w.q AS wait_q, w.t_seconds AS wait_t, w.w_minutes AS wait_w,
         w.congestion AS wait_congestion, w.source AS wait_source,
         w.computed_at AS wait_computed_at, w.observation_at AS wait_observation_at,
         w.freshness AS wait_freshness
  FROM atms a
  LEFT JOIN wait_snapshots w ON w.atm_id = a.id
`;

/** Shared column list for public ATM list/detail (joins bank + wait). */
export const PUBLIC_ATM_SELECT_COLS = `
  a.id, a.name, b.name AS bank_name, b.logo_object_key,
  a.region, a.district, a.town, a.lat, a.lng, a.hours_json, a.status,
  COALESCE((
    SELECT array_agg(s.service_code ORDER BY s.service_code)
    FROM atm_services s WHERE s.atm_id = a.id AND s.available = true
  ), '{}') AS services,
  COALESCE((
    SELECT array_agg(c.brand_code ORDER BY c.brand_code)
    FROM atm_card_brands c WHERE c.atm_id = a.id AND c.supported = true
  ), '{}') AS card_brands,
  w.q AS wait_q, w.t_seconds AS wait_t, w.w_minutes AS wait_w,
  w.congestion AS wait_congestion, w.source AS wait_source,
  w.computed_at AS wait_computed_at, w.observation_at AS wait_observation_at
`;

export async function loadServicesMap(
  db: DbClient,
  atmId: string,
): Promise<Record<string, boolean>> {
  const { rows } = await db.query<{ service_code: string; available: boolean }>(
    `SELECT service_code, available FROM atm_services WHERE atm_id = $1`,
    [atmId],
  );
  return Object.fromEntries(rows.map((r) => [r.service_code, r.available]));
}

export async function loadBrandsMap(
  db: DbClient,
  atmId: string,
): Promise<Record<string, boolean>> {
  const { rows } = await db.query<{ brand_code: string; supported: boolean }>(
    `SELECT brand_code, supported FROM atm_card_brands WHERE atm_id = $1`,
    [atmId],
  );
  return Object.fromEntries(rows.map((r) => [r.brand_code, r.supported]));
}

export async function replaceServices(
  db: DbClient,
  atmId: string,
  services: Record<string, boolean>,
) {
  await db.query(`DELETE FROM atm_services WHERE atm_id = $1`, [atmId]);
  for (const [code, available] of Object.entries(services)) {
    await db.query(
      `INSERT INTO atm_services (atm_id, service_code, available) VALUES ($1,$2,$3)`,
      [atmId, code, available],
    );
  }
}

export async function replaceBrands(
  db: DbClient,
  atmId: string,
  brands: Record<string, boolean>,
) {
  await db.query(`DELETE FROM atm_card_brands WHERE atm_id = $1`, [atmId]);
  for (const [code, supported] of Object.entries(brands)) {
    await db.query(
      `INSERT INTO atm_card_brands (atm_id, brand_code, supported) VALUES ($1,$2,$3)`,
      [atmId, code, supported],
    );
  }
}

function hoursSummary(hoursJson: unknown): string | null {
  if (hoursJson == null) return null;
  if (typeof hoursJson === 'string') return hoursJson;
  if (typeof hoursJson === 'object' && hoursJson !== null && 'summary' in hoursJson) {
    const s = (hoursJson as { summary?: unknown }).summary;
    return typeof s === 'string' ? s : null;
  }
  return JSON.stringify(hoursJson);
}

export async function toBankAtmDto(db: DbClient, row: BankAtmRow) {
  let wait: WaitSnapshot | undefined;
  if (row.wait_computed_at != null && row.wait_q != null) {
    wait = waitSummaryFromRow({
      atm_id: row.id,
      q: row.wait_q,
      t_seconds: row.wait_t ?? config.waitDefaultTSec,
      w_minutes: row.wait_w ?? 0,
      congestion: (row.wait_congestion ?? 'low') as 'low' | 'moderate' | 'high',
      source: row.wait_source ?? 'human_report',
      computed_at: row.wait_computed_at,
      observation_at: row.wait_observation_at,
    });
  }

  return {
    id: row.id,
    siteCode: row.site_code,
    name: row.name,
    region: row.region,
    district: row.district,
    town: row.town,
    lat: row.lat,
    lng: row.lng,
    hours: hoursSummary(row.hours_json),
    status: row.status,
    activeLanes: row.active_lanes,
    services: await loadServicesMap(db, row.id),
    cardBrands: await loadBrandsMap(db, row.id),
    retiredAt: row.retired_at ? row.retired_at.toISOString() : null,
    wait: wait
      ? {
          queueCount: wait.queueCount,
          waitMinutes: wait.waitMinutes,
          congestion: wait.congestion,
          freshness: wait.freshness,
          sourceType: wait.sourceType,
          computedAt: wait.computedAt,
          observationAt: wait.observationAt,
        }
      : undefined,
  };
}

export async function insertAtm(
  db: DbClient,
  input: {
    bankId: string;
    siteCode: string;
    name: string;
    region: string;
    district: string;
    town: string;
    lat: number;
    lng: number;
    status: string;
    hours?: string;
    activeLanes: number;
    services?: Record<string, boolean>;
    cardBrands?: Record<string, boolean>;
  },
) {
  const id = randomUUID();
  await db.query(
    `INSERT INTO atms (
       id, bank_id, site_code, name, region, district, town, lat, lng, status, hours_json, active_lanes
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      id,
      input.bankId,
      input.siteCode.toUpperCase(),
      input.name,
      input.region,
      input.district,
      input.town,
      input.lat,
      input.lng,
      input.status,
      input.hours ? JSON.stringify({ summary: input.hours }) : null,
      input.activeLanes,
    ],
  );
  if (input.services) await replaceServices(db, id, input.services);
  if (input.cardBrands) await replaceBrands(db, id, input.cardBrands);
  return id;
}

export async function getBankAtm(
  db: DbClient,
  atmId: string,
  bankId?: string,
): Promise<BankAtmRow | null> {
  const params: unknown[] = [atmId];
  let sql = `${BANK_ATM_SELECT} WHERE a.id = $1`;
  if (bankId) {
    params.push(bankId);
    sql += ` AND a.bank_id = $2`;
  }
  const { rows } = await db.query<BankAtmRow>(sql, params);
  return rows[0] ?? null;
}
