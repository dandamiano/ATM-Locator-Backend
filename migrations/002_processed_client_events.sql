-- Idempotency ledger for queue offline sync / retries.
-- One row per client_event_id; keeps service_timer_events = one row per real timer.
CREATE TABLE processed_client_events (
  client_event_id UUID PRIMARY KEY,
  atm_id          UUID NOT NULL REFERENCES atms(id),
  event_type      TEXT NOT NULL,
  entity_id       UUID,
  processed_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX processed_client_events_atm ON processed_client_events (atm_id, processed_at DESC);
