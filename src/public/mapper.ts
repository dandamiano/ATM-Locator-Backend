/**
 * @module public/mapper
 * @layer domain
 * @description Maps DB rows to PublicAtmDto allow-list; hides stale wait fields.
 */

import type { WaitSnapshot } from '../wait/engine.js';
import { config } from '../config.js';

const ALLOWED_KEYS = new Set([
  'id',
  'name',
  'bankName',
  'bankLogoUrl',
  'region',
  'district',
  'town',
  'lat',
  'lng',
  'hours',
  'status',
  'services',
  'cardBrands',
  'queueCount',
  'waitMinutes',
  'congestion',
  'freshness',
  'lastUpdatedAt',
  'sourceType',
  'distanceMeters',
  'directionsHint',
]);

export type PublicAtmRow = {
  id: string;
  name: string;
  bank_name: string;
  logo_object_key: string | null;
  region: string;
  district: string;
  town: string;
  lat: number;
  lng: number;
  hours_json: unknown;
  status: string;
  services: string[] | null;
  card_brands: string[] | null;
  distance_meters?: number | null;
  wait_q?: number | null;
  wait_t?: number | null;
  wait_w?: string | number | null;
  wait_congestion?: string | null;
  wait_source?: string | null;
  wait_computed_at?: Date | null;
  wait_observation_at?: Date | null;
};

export type PublicAtmDto = {
  id: string;
  name: string;
  bankName: string;
  bankLogoUrl: string | null;
  region: string;
  district: string;
  town: string;
  lat: number;
  lng: number;
  hours: string | null;
  status: string;
  services: string[];
  cardBrands: string[];
  queueCount?: number | null;
  waitMinutes?: number | null;
  congestion?: string | null;
  freshness?: string | null;
  lastUpdatedAt?: string | null;
  sourceType?: string | null;
  distanceMeters?: number | null;
  directionsHint?: string | null;
};

function hoursSummary(hoursJson: unknown): string | null {
  if (hoursJson == null) return null;
  if (typeof hoursJson === 'string') return hoursJson;
  if (typeof hoursJson === 'object' && hoursJson !== null && 'summary' in hoursJson) {
    const s = (hoursJson as { summary?: unknown }).summary;
    return typeof s === 'string' ? s : null;
  }
  return JSON.stringify(hoursJson);
}

function logoUrl(key: string | null): string | null {
  if (!key) return null;
  if (key.startsWith('http://') || key.startsWith('https://')) return key;
  return `${config.publicBaseUrl}/files/${key.replace(/^\/+/, '')}`;
}

export function mapPublicAtm(
  row: PublicAtmRow,
  wait?: WaitSnapshot | null,
): PublicAtmDto {
  const freshness = wait?.freshness ?? 'stale';
  const live = freshness !== 'stale' && wait != null;

  const dto: PublicAtmDto = {
    id: row.id,
    name: row.name,
    bankName: row.bank_name,
    bankLogoUrl: logoUrl(row.logo_object_key),
    region: row.region,
    district: row.district,
    town: row.town,
    lat: row.lat,
    lng: row.lng,
    hours: hoursSummary(row.hours_json),
    status: row.status,
    services: row.services ?? [],
    cardBrands: row.card_brands ?? [],
  };

  if (wait) {
    dto.freshness = freshness;
    dto.lastUpdatedAt = wait.observationAt;
    dto.sourceType = wait.sourceType;
    if (live) {
      dto.queueCount = wait.queueCount;
      dto.waitMinutes = wait.waitMinutes;
      dto.congestion = wait.congestion;
    } else {
      dto.queueCount = null;
      dto.waitMinutes = null;
      dto.congestion = null;
    }
  }

  if (row.distance_meters != null) {
    dto.distanceMeters = Math.round(row.distance_meters);
  }

  return dto;
}

export function assertAllowList(dto: Record<string, unknown>): void {
  for (const key of Object.keys(dto)) {
    if (!ALLOWED_KEYS.has(key)) {
      throw new Error(`Forbidden public field leaked: ${key}`);
    }
  }
}

export function publicAtmKeys(): string[] {
  return [...ALLOWED_KEYS];
}

export { ALLOWED_KEYS };
