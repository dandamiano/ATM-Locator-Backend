import { randomUUID } from 'node:crypto';
import type { DbClient } from '../db/pool.js';

export async function writeAudit(
  db: DbClient,
  input: {
    actorUserId?: string | null;
    bankId?: string | null;
    action: string;
    entityType: string;
    entityId?: string | null;
    meta?: Record<string, unknown>;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO audit_events (id, actor_user_id, bank_id, action, entity_type, entity_id, meta_json)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [
      randomUUID(),
      input.actorUserId ?? null,
      input.bankId ?? null,
      input.action,
      input.entityType,
      input.entityId ?? null,
      JSON.stringify(input.meta ?? {}),
    ],
  );
}
