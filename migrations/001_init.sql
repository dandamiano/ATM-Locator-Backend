CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE banks (
  id            UUID PRIMARY KEY,
  name          TEXT NOT NULL,
  slug          TEXT NOT NULL UNIQUE,
  status        TEXT NOT NULL CHECK (status IN ('active','suspended')),
  logo_object_key TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id            UUID PRIMARY KEY,
  bank_id       UUID REFERENCES banks(id),
  role          TEXT NOT NULL,
  email         CITEXT UNIQUE,
  employee_id   TEXT,
  display_name  TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  pin_hash      TEXT,
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
  external_id   TEXT,
  retired_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (bank_id, external_id)
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
  label TEXT,
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
  client_event_id UUID NOT NULL UNIQUE,
  session_id UUID REFERENCES reporter_sessions(id)
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

CREATE INDEX atms_bank_status ON atms (bank_id, status) WHERE retired_at IS NULL;
CREATE INDEX atms_geo ON atms (lat, lng);
CREATE INDEX qo_atm_observed ON queue_observations (atm_id, observed_at DESC);
CREATE INDEX reporter_sessions_token ON reporter_sessions (token_hash);
CREATE INDEX users_bank_role ON users (bank_id, role);
CREATE INDEX audit_bank_at ON audit_events (bank_id, at DESC);
CREATE INDEX ste_atm_status ON service_timer_events (atm_id, status);
