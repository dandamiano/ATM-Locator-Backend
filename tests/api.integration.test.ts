import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../src/app.js';
import { pool } from '../src/db/pool.js';
import { seedIds } from '../src/db/seed.js';
import { resetRateLimitBuckets } from '../src/ratelimit/public.js';

type App = Awaited<ReturnType<typeof buildApp>>;

let app: App;

async function json(
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  url: string,
  opts?: { body?: unknown; token?: string; headers?: Record<string, string> },
) {
  const res = await app.inject({
    method,
    url: `/api/v1${url}`,
    headers: {
      'content-type': 'application/json',
      ...(opts?.token ? { authorization: `Bearer ${opts.token}` } : {}),
      ...(opts?.headers ?? {}),
    },
    payload: opts?.body as string | object | Buffer | undefined,
  });
  return {
    status: res.statusCode,
    headers: res.headers,
    body: res.body ? JSON.parse(res.body) : null,
  };
}

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  process.env.JWT_SECRET =
    process.env.JWT_SECRET || 'test-only-jwt-secret-at-least-32-bytes!!';
  resetRateLimitBuckets();
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('Phase 1 spine', () => {
  it('lists cities', async () => {
    const res = await json('GET', '/public/meta/cities');
    expect(res.status).toBe(200);
    expect(res.body.cities.length).toBeGreaterThan(0);
  });

  it('nearby clamps and returns public fields', async () => {
    const res = await json(
      'GET',
      '/public/atms/nearby?lat=-13.9626&lng=33.7741&radius=50000&limit=100',
    );
    expect(res.status).toBe(200);
    expect(res.body.items.length).toBeLessThanOrEqual(50);
    if (res.body.items[0]) {
      expect(res.body.items[0]).toHaveProperty('bankName');
      expect(res.body.items[0]).not.toHaveProperty('password_hash');
      expect(res.body.items[0]).not.toHaveProperty('pin_hash');
    }
  });

  it('logs in bank admin', async () => {
    const res = await json('POST', '/auth/login', {
      body: { email: 'admin@nbm.mw', password: 'ChangeMe123!' },
    });
    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeTruthy();
    expect(res.body.user.role).toBe('bank_admin');
  });
});

describe('Phase 2 bank + queue', () => {
  it('enforces tenancy and RBAC', async () => {
    const ops = await json('POST', '/auth/login', {
      body: { email: 'ops@nbm.mw', password: 'ChangeMe123!' },
    });
    const createUser = await json('POST', '/bank/users', {
      token: ops.body.accessToken,
      body: {
        role: 'bank_operator',
        password: 'ChangeMe123!',
        displayName: 'Nope',
      },
    });
    expect(createUser.status).toBe(403);

    const reporterLogin = await json('POST', '/auth/login', {
      body: { email: 'reporter@nbm.mw', password: 'ChangeMe123!' },
    });
    const bankAtms = await json('GET', '/bank/atms', {
      token: reporterLogin.body.accessToken,
    });
    expect(bankAtms.status).toBe(403);
  });

  it('check-in, observation idempotency, timer limit, honesty', async () => {
    const bad = await json('POST', '/auth/reporter/check-in', {
      body: {
        siteCode: 'NBM-LLW-001',
        employeeId: 'REP001',
        pin: '0000',
      },
    });
    expect(bad.status).toBe(401);

    const checkIn = await json('POST', '/auth/reporter/check-in', {
      body: {
        siteCode: 'NBM-LLW-001',
        employeeId: 'REP001',
        pin: '1234',
        gps: { lat: -13.9626, lng: 33.7741 },
      },
    });
    expect(checkIn.status).toBe(200);
    const session = checkIn.body.sessionToken as string;

    const eventId = randomUUID();
    const obs1 = await json('POST', '/queue/observations', {
      token: session,
      body: {
        count: 4,
        observedAt: new Date().toISOString(),
        clientEventId: eventId,
      },
    });
    expect(obs1.status).toBe(200);
    expect(obs1.body.status).toBe('accepted');
    expect(obs1.body.wait.waitMinutes).not.toBeNull();

    const obs2 = await json('POST', '/queue/observations', {
      token: session,
      body: {
        count: 4,
        observedAt: new Date().toISOString(),
        clientEventId: eventId,
      },
    });
    expect(obs2.body.status).toBe('duplicate');

    const count = await pool.query(
      `SELECT COUNT(*)::int AS c FROM queue_observations WHERE client_event_id = $1`,
      [eventId],
    );
    expect(count.rows[0].c).toBe(1);

    const timers = [];
    for (let i = 0; i < 3; i++) {
      const t = await json('POST', '/queue/timers', {
        token: session,
        body: { action: 'start', clientEventId: randomUUID() },
      });
      expect(t.status).toBe(200);
      timers.push(t.body.timerId);
    }
    const fourth = await json('POST', '/queue/timers', {
      token: session,
      body: { action: 'start', clientEventId: randomUUID() },
    });
    expect(fourth.status).toBe(409);

    // Force stale snapshot and ensure public hides waitMinutes
    await pool.query(
      `UPDATE wait_snapshots
       SET observation_at = now() - interval '10 minutes',
           q = 9, w_minutes = 13.5, congestion = 'high', freshness = 'fresh'
       WHERE atm_id = $1`,
      [seedIds.ATMS[0]!.id],
    );
    const detail = await json(
      'GET',
      `/public/atms/${seedIds.ATMS[0]!.id}`,
    );
    expect(detail.status).toBe(200);
    expect(detail.body.freshness).toBe('stale');
    expect(detail.body.waitMinutes).toBeNull();
  });
});

describe('Phase 3 platform + integrations', () => {
  it('platform dashboard and api key bulk upsert', async () => {
    const platform = await json('POST', '/auth/login', {
      body: { email: 'platform@atmlocator.mw', password: 'ChangeMe123!' },
    });
    expect(platform.status).toBe(200);
    const dash = await json('GET', '/platform/dashboard', {
      token: platform.body.accessToken,
    });
    expect(dash.status).toBe(200);
    expect(dash.body.atmCount).toBeGreaterThan(0);

    const admin = await json('POST', '/auth/login', {
      body: { email: 'admin@nbm.mw', password: 'ChangeMe123!' },
    });
    const key = await json('POST', '/bank/api-keys', {
      token: admin.body.accessToken,
      body: { label: 'test', scopes: ['atms:write'] },
    });
    expect(key.status).toBe(201);

    const bulk = await json('PUT', '/integrations/atms/bulk', {
      headers: { 'x-api-key': key.body.apiKey },
      body: {
        atms: [
          {
            externalId: 'EXT-1',
            siteCode: 'NBM-EXT-001',
            name: 'Bulk ATM',
            lat: -13.96,
            lng: 33.77,
            status: 'operational',
            town: 'Lilongwe',
          },
        ],
      },
    });
    expect(bulk.status).toBe(200);
    expect(bulk.body.created + bulk.body.updated).toBeGreaterThanOrEqual(1);
  });
});
