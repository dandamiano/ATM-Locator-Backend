# Platform Server — Implementation Guide

**Basis:** SRS v1.4 · SAD v1.1 · SDD v1.0 · OpenAPI `atm-locator-v1.yaml`  
**Audience:** Backend engineers implementing **platform-api**  
**Mode:** Design → build instructions (not a live coding session)  
**Version:** 1.0

---

## 1. What you are building

One **Platform API** service that is the system of record for:

| Concern | OpenAPI tag |
| --- | --- |
| Anonymous locate | `Public` |
| Bank/platform login + reporter check-in | `Auth` |
| Bank tenant portal | `Bank` |
| Field queue reporting | `Queue` |
| Platform ops | `Platform` |
| Bank machine sync | `Integrations` |

Clients (KMP, portal, queue PWA, later WhatsApp) are **thin**. All honesty, tenancy, and wait math live on the server.

**Stack (from SDD §2.3):**

| Layer | Choice |
| --- | --- |
| Runtime | Node.js + TypeScript HTTP API (Fastify or NestJS or Next Route Handlers — pick one and stick to it) |
| DB | PostgreSQL (system of record) |
| Cache | Redis (rate limits; optional session hints) |
| Objects | S3-compatible (logos, QR PDFs) |
| Auth | JWT (humans) + opaque reporter sessions + hashed API keys (`bank_api`) |
| Contract | Implement **exactly** against `docs/openapi/atm-locator-v1.yaml` |

Pilot topology: 1 API node + managed Postgres (+ Redis when you add hard rate limits). Do not split wait-engine into a separate worker until load requires it.

---

## 2. Repo layout (recommended)

```
platform-api/
  openapi/atm-locator-v1.yaml          # copy or symlink from docs
  src/
    http/          # routes, validation, error mapper, request-id
    auth/          # JWT, reporter sessions, API keys, RBAC
    tenancy/       # bank_id resolution + ownership asserts
    public/        # nearby, search, detail → PublicAtmDto
    banks/
    atms/
    users/
    queue/         # observations, timers, sync
    wait/          # Q,T,W + freshness + congestion
    audit/
    reports/
    ratelimit/
    db/            # migrations, queries
  migrations/
  tests/
```

Cross-cutting rules (SDD §4.2):

1. Mutating bank/reporter routes: **tenant + role** before write.  
2. Public handlers return **allow-list fields only**.  
3. Wait recompute **synchronously** after accepted queue/timer events (MVP).  
4. Audit denials and rate-limit hits; never log secrets/PINs/tokens.

---

## 3. PostgreSQL schema (build this first)

### 3.1 Tables (map 1:1 from SDD §5.2)

```sql
-- banks
CREATE TABLE banks (
  id            UUID PRIMARY KEY,
  name          TEXT NOT NULL,
  slug          TEXT NOT NULL UNIQUE,
  status        TEXT NOT NULL CHECK (status IN ('active','suspended')),
  logo_object_key TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- users (bank_id NULL for platform roles)
CREATE TABLE users (
  id            UUID PRIMARY KEY,
  bank_id       UUID REFERENCES banks(id),
  role          TEXT NOT NULL,  -- bank_admin|bank_operator|queue_reporter|platform_admin|platform_analyst
  email         CITEXT UNIQUE,
  employee_id   TEXT,
  display_name  TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  pin_hash      TEXT,           -- required for queue_reporter
  status        TEXT NOT NULL CHECK (status IN ('active','disabled')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (bank_id, employee_id)
);

CREATE TABLE atms (
  id            UUID PRIMARY KEY,
  bank_id       UUID NOT NULL REFERENCES banks(id),
  site_code     TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  region        TEXT NOT NULL,
  district      TEXT NOT NULL,
  town          TEXT NOT NULL,
  lat           DOUBLE PRECISION NOT NULL,
  lng           DOUBLE PRECISION NOT NULL,
  status        TEXT NOT NULL,
  hours_json    JSONB,
  active_lanes  INT NOT NULL DEFAULT 1 CHECK (active_lanes >= 1),
  retired_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE atm_services (
  atm_id UUID REFERENCES atms(id) ON DELETE CASCADE,
  service_code TEXT NOT NULL,
  available BOOLEAN NOT NULL,
  PRIMARY KEY (atm_id, service_code)
);

CREATE TABLE atm_card_brands (
  atm_id UUID REFERENCES atms(id) ON DELETE CASCADE,
  brand_code TEXT NOT NULL,
  supported BOOLEAN NOT NULL,
  PRIMARY KEY (atm_id, brand_code)
);

CREATE TABLE api_credentials (
  id UUID PRIMARY KEY,
  bank_id UUID NOT NULL REFERENCES banks(id),
  key_prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  scopes TEXT[] NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ
);

CREATE TABLE reporter_sessions (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id),
  atm_id UUID NOT NULL REFERENCES atms(id),
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  gps_warn BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE queue_observations (
  id UUID PRIMARY KEY,
  atm_id UUID NOT NULL REFERENCES atms(id),
  source TEXT NOT NULL CHECK (source IN ('human_report','camera_vision')),
  count INT NOT NULL CHECK (count >= 0 AND count <= 500),
  observed_at TIMESTAMPTZ NOT NULL,
  confidence REAL,
  session_id UUID REFERENCES reporter_sessions(id),
  client_event_id UUID NOT NULL UNIQUE,
  remark TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE service_timer_events (
  id UUID PRIMARY KEY,
  atm_id UUID NOT NULL REFERENCES atms(id),
  user_id UUID NOT NULL REFERENCES users(id),
  status TEXT NOT NULL CHECK (status IN ('running','completed','cancelled')),
  started_at TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ,
  duration_sec INT,
  client_event_id UUID NOT NULL UNIQUE
);

CREATE TABLE wait_snapshots (
  atm_id UUID PRIMARY KEY REFERENCES atms(id),
  q INT NOT NULL,
  t_seconds INT NOT NULL,
  w_minutes NUMERIC(8,1) NOT NULL,
  congestion TEXT NOT NULL,
  freshness TEXT NOT NULL,
  source TEXT NOT NULL,
  computed_at TIMESTAMPTZ NOT NULL,
  observation_at TIMESTAMPTZ
);

CREATE TABLE audit_events (
  id UUID PRIMARY KEY,
  at TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor_user_id UUID,
  bank_id UUID,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  meta_json JSONB NOT NULL DEFAULT '{}'
);
```

### 3.2 Indexes (required)

```sql
CREATE INDEX atms_bank_status ON atms (bank_id, status) WHERE retired_at IS NULL;
CREATE INDEX atms_geo ON atms (lat, lng);           -- or PostGIS geography later
CREATE INDEX qo_atm_observed ON queue_observations (atm_id, observed_at DESC);
CREATE INDEX reporter_sessions_token ON reporter_sessions (token_hash);
CREATE INDEX users_bank_role ON users (bank_id, role);
CREATE INDEX audit_bank_at ON audit_events (bank_id, at DESC);
```

Optional upgrade: PostGIS `geography(Point)` + `ST_DWithin` for nearby.

---

## 4. Auth & tenancy (implement before bank writes)

### 4.1 Three credential types

| Type | Used by | Storage | Header |
| --- | --- | --- | --- |
| Access JWT | Portal / platform humans | Signed; claims only | `Authorization: Bearer <jwt>` |
| Reporter session | Queue app after check-in | Opaque token; **hash** in DB | `Authorization: Bearer <session>` |
| API key | `bank_api` integrations | Prefix + **hash** | e.g. `X-Api-Key` |

**JWT claims (SDD):** `sub`, `role`, `bank_id?`, `exp`.  
**Never** embed a fallback JWT secret in source for production. Fail boot if `JWT_SECRET` missing (min 32 bytes entropy).

### 4.2 Password / PIN

- Hash with argon2id (preferred) or bcrypt.  
- `queue_reporter`: employee_id + PIN at check-in; password still exists for optional portal if needed.  
- Lockout / backoff after N failures (audit `auth.failure`).

### 4.3 Guards (middleware order)

```
request-id → rate-limit → auth (optional|required) → role → tenant owns → handler
```

| Guard | Routes |
| --- | --- |
| PublicRateLimit | `/public/*` |
| JwtAuth + RequireRole | `/bank/*`, `/platform/*` |
| ReporterSession (bound to `atm_id`) | `/queue/*` |
| ApiKeyAuth + bank scope | `/integrations/*` |
| TenantOwns(atm\|user) | any object by id |

### 4.4 Check-in algorithm

`POST /auth/reporter/check-in`

1. Resolve ATM by `site_code` or `qr_payload` (uppercase normalize).  
2. Find active `queue_reporter` with matching `employee_id` and same `bank_id`.  
3. Verify PIN against `pin_hash`.  
4. Soft GPS: if `gps` present and Haversine > soft radius (e.g. 250 m) → `gpsWarning: true` (do **not** hard-block MVP).  
5. Invalidate prior sessions for that user; insert new session (8h default).  
6. Return opaque `sessionToken` once; store only hash.

---

## 5. Wait engine (library inside API)

Implement as `src/wait/` — no separate process in MVP.

### 5.1 Inputs

| Symbol | Source |
| --- | --- |
| `Q` | Latest `queue_observations.count` for ATM |
| `T` | Median of last ~20 **completed** timer `duration_sec` in (15, 900); else default 90s |
| `N` | `atms.active_lanes` (≥ 1) |

### 5.2 Formulae

```
W_seconds = (Q * T) / N
W_minutes = round(W_seconds / 60, 1)
```

Congestion (seed): `low` 0–2 · `moderate` 3–5 · `high` 6+.

### 5.3 Freshness (config via env)

| Band | Age of `observation_at` | Public DTO behaviour |
| --- | --- | --- |
| `fresh` | ≤ `WAIT_FRESH_SEC` (120) | Show `waitMinutes` |
| `aging` | ≤ `WAIT_AGING_SEC` (300) | Show `waitMinutes` + aging label |
| `stale` | else / no observation | **Hide** live numeric wait; return `freshness: stale` |

**Important:** Persist `wait_snapshots` after ingest, but **re-evaluate freshness from `observation_at` at read time** so a snapshot does not stay “fresh” forever.

### 5.4 Recompute triggers

Call `recomputeWait(atmId)` after:

- Accepted observation insert (or duplicate no-op)  
- Timer **complete**  
- Batch `/queue/sync` that touches that ATM  

Public nearby/search/detail: join `wait_snapshots` + apply live freshness → map to `PublicAtmDto`.

---

## 6. PublicAtmDto (allow-list only)

Return **only**:

```
id, name, bankName, bankLogoUrl,
region, district, town, lat, lng, hours,
status, services[], cardBrands[],
queueCount?, waitMinutes?, congestion?, freshness?,
lastUpdatedAt?, sourceType?, distanceMeters?, directionsHint?
```

**Never** expose: PIN material, employee lists, raw sessions, audit, internal notes, API keys.

Nearby: Haversine or PostGIS; **cap** `radius` and `limit` server-side (OpenAPI maxima).

---

## 7. Route build order (recommended)

Implement and test in this sequence so each slice is demoable.

### Slice A — Spine

1. Migrations + seed 1 bank, 3 seats, 8–15 ATMs (Lilongwe/Blantyre).  
2. `GET /public/meta/cities`  
3. `GET /public/atms/nearby|search|{id}` (wait may be null/stale).  
4. `POST /auth/login` + JWT middleware smoke.

### Slice B — Bank ATMs

5. `GET/POST /bank/atms`, `GET/PATCH /bank/atms/{id}`  
6. Role rules: admin create/edit identity; operator status/services/brands.  
7. `GET /bank/atms/{id}/qr.pdf` (Site Code sheet).  
8. `GET/POST /bank/users` (PIN required for reporters).

### Slice C — Queue + wait

9. `POST /auth/reporter/check-in`  
10. `GET /queue/session`  
11. `POST /queue/observations` + wait recompute  
12. `POST /queue/timers` (max 3 running per reporter/ATM)  
13. `POST /queue/sync` (idempotent by `client_event_id`)  
14. Confirm public DTO shows Fresh → Aging → Stale over time.

### Slice D — Platform + integrations

15. `/platform/banks`, `/platform/dashboard`, `/platform/audit`  
16. `/bank/api-keys` + `PUT /integrations/atms/bulk`  
17. `/bank/reports/fleet-health`, `/queue-compliance`  
18. Rate limits on `/public/*` → `429` + `Retry-After`

---

## 8. Idempotency & offline sync

Queue clients send `client_event_id` (UUID) on every observation/timer/sync event.

```
IF exists(client_event_id) → return duplicate (same wait snapshot); HTTP 200
ELSE insert → recompute → accepted
```

`/queue/sync` body: ordered `events[]`. Response should classify each id: `accepted` | `duplicate` | `rejected`.

Preserve client `observed_at` / `at` timestamps (do not overwrite with server “now” for honesty).

---

## 9. Error & HTTP conventions

```json
{ "error": { "code": "validation_error", "message": "...", "details": {} } }
```

| Code | Typical status |
| --- | --- |
| `validation_error` | 400 |
| `unauthorized` | 401 |
| `forbidden` | 403 |
| `not_found` | 404 |
| `conflict` | 409 |
| `rate_limited` | 429 |

Attach `X-Request-Id` on every response.

---

## 10. Security checklist (must pass before any hosted publish)

| Rule | Implementation |
| --- | --- |
| No hardcoded JWT/API secrets | Boot fails without `JWT_SECRET` |
| Demo reset not public | Remove, or guard with platform_admin + non-prod flag |
| No unauthenticated wait mutation | All queue writes require reporter session |
| Tenant isolation | Every ATM/user query filters `bank_id` |
| Public allow-list | Mapper function; unit-test forbidden fields absent |
| Secrets hashed | passwords, PINs, API keys, session tokens |
| Rate limit public | Per IP (+ optional `X-App-Key` bucket) |
| Seed passwords | Rotate or force change outside local/dev |

---

## 11. Config (environment)

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Postgres |
| `REDIS_URL` | Rate limits (optional early) |
| `JWT_SECRET` | **Required** in staging/prod |
| `WAIT_FRESH_SEC` / `WAIT_AGING_SEC` | Freshness bands |
| `WAIT_DEFAULT_T_SEC` | Fallback service time (90) |
| `GPS_SOFT_RADIUS_M` | Check-in soft warning (250) |
| `OBJECT_STORE_*` | Logos / QR PDFs |
| `PUBLIC_RATE_LIMIT_*` | Public API quotas |

---

## 12. Test plan (server-focused)

| Test | Assert |
| --- | --- |
| Honesty | Stale snapshot never returns live `waitMinutes` |
| Tenancy | Bank A JWT cannot PATCH Bank B ATM |
| RBAC | Operator cannot create users; reporter cannot hit `/bank/atms` |
| Check-in | Bad PIN → 401; good PIN → session bound to ATM |
| Idempotency | Same `client_event_id` twice → one observation row |
| Timers | 4th concurrent start → 409 |
| Nearby caps | `radius`/`limit` clamped |
| Public DTO | Response keys ⊆ allow-list |
| Bulk sync | API key only mutates own `bank_id` |

---

## 13. What not to build on the server (yet)

| Deferred | Why |
| --- | --- |
| WhatsApp webhook handlers | Phase 2 chatbot service calls `/public/*` |
| Camera vision pipeline | Same `queue_observations.source=camera_vision` later |
| USSD | Separate adapter |
| ML wait models | Keep `W=Q×T` until timers give enough `T` history |
| Rotating QR tokens | MVP static Site Code + PIN |

---

## 14. Delivery mapping

| Phase | Server work |
| --- | --- |
| 0 | Schema, OpenAPI stubs, seed, auth guards |
| 1 | Public + bank ATMs/users + queue + wait + QR |
| 1b | Reports, API keys, bulk integration, hard rate limits |
| 2 | Service credential for WhatsApp bot; `wa_sessions` table |
| 3 | Camera ingest path; optional async wait worker |

---

## 15. Source of truth

| Artefact | Use |
| --- | --- |
| `docs/openapi/atm-locator-v1.yaml` | Paths, schemas, status codes |
| `docs/SDD-ATM-Locator-Malawi.md` | Packages, tables, wait, security |
| `docs/SRS-ATM-Locator-Malawi.md` | FR/NFR acceptance |
| `docs/UX-Wireframes-ATM-Locator-Malawi.md` | Client expectations only — server still owns truth |

When OpenAPI and this guide disagree, **OpenAPI wins for wire format**; SDD wins for invariants (tenancy, honesty, allow-list).

---

## Change log

| Version | Notes |
| --- | --- |
| 1.0 | Server implementation guide from signed-off design pack; docs-only (no further app build in this workspace) |
