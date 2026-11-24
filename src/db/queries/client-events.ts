/**
 * @module db/queries/client-events
 * @layer query
 * @description Idempotency ledger for queue client_event_id values.
 */

import type { DbClient } from '../pool.js';

export async function findProcessedEvent(db: DbClient, clientEventId: string) {
  const { rows } = await db.query<{
    client_event_id: string;
    entity_id: string | null;
    event_type: string;
  }>(
    `SELECT client_event_id, entity_id, event_type
     FROM processed_client_events WHERE client_event_id = $1`,
    [clientEventId],
  );
  return rows[0] ?? null;
}

/** Records a processed client event. Caller must be inside a transaction when paired with domain writes. */
export async function recordProcessedEvent(
  db: DbClient,
  input: {
    clientEventId: string;
    atmId: string;
    eventType: string;
    entityId?: string | null;
  },
) {
  await db.query(
    `INSERT INTO processed_client_events (client_event_id, atm_id, event_type, entity_id)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (client_event_id) DO NOTHING`,
    [
      input.clientEventId,
      input.atmId,
      input.eventType,
      input.entityId ?? null,
    ],
  );
}
