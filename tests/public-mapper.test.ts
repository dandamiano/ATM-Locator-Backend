import { describe, expect, it } from 'vitest';
import {
  ALLOWED_KEYS,
  assertAllowList,
  mapPublicAtm,
} from '../src/public/mapper.js';
import {
  freshnessFromObservationAt,
  toPublicWaitSnapshot,
} from '../src/wait/engine.js';

describe('PublicAtmDto allow-list', () => {
  it('only emits allowed keys', () => {
    const dto = mapPublicAtm({
      id: 'a1111111-1111-4111-8111-111111111101',
      name: 'Test',
      bank_name: 'NBM',
      logo_object_key: null,
      region: 'Central',
      district: 'Lilongwe',
      town: 'Lilongwe',
      lat: -13.9,
      lng: 33.7,
      hours_json: { summary: '9-5' },
      status: 'operational',
      services: ['cash_withdrawal'],
      card_brands: ['visa'],
    });
    assertAllowList(dto as unknown as Record<string, unknown>);
    for (const key of Object.keys(dto)) {
      expect(ALLOWED_KEYS.has(key)).toBe(true);
    }
  });

  it('hides live wait when stale', () => {
    const wait = toPublicWaitSnapshot({
      atmId: 'a1111111-1111-4111-8111-111111111101',
      q: 8,
      tSeconds: 90,
      wMinutes: 12,
      congestion: 'high',
      source: 'human_report',
      computedAt: new Date(),
      observationAt: new Date(Date.now() - 10 * 60 * 1000),
    });
    expect(wait.freshness).toBe('stale');
    expect(wait.waitMinutes).toBeNull();

    const dto = mapPublicAtm(
      {
        id: 'a1111111-1111-4111-8111-111111111101',
        name: 'Test',
        bank_name: 'NBM',
        logo_object_key: null,
        region: 'Central',
        district: 'Lilongwe',
        town: 'Lilongwe',
        lat: -13.9,
        lng: 33.7,
        hours_json: null,
        status: 'operational',
        services: [],
        card_brands: [],
      },
      wait,
    );
    expect(dto.waitMinutes).toBeNull();
    expect(dto.freshness).toBe('stale');
  });
});

describe('freshness bands', () => {
  it('marks fresh/aging/stale by age', () => {
    const now = new Date('2026-01-01T12:00:00Z');
    expect(
      freshnessFromObservationAt(new Date('2026-01-01T11:59:00Z'), now),
    ).toBe('fresh');
    expect(
      freshnessFromObservationAt(new Date('2026-01-01T11:56:00Z'), now),
    ).toBe('aging');
    expect(
      freshnessFromObservationAt(new Date('2026-01-01T11:50:00Z'), now),
    ).toBe('stale');
  });
});
