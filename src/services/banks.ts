/**
 * @module services/banks
 * @layer service
 * @description Bank profile, logo, and API key lifecycle.
 */

import { randomUUID } from 'node:crypto';
import { apiKeyParts } from '../auth/crypto.js';
import { AppError } from '../http/errors.js';
import { writeAudit } from '../audit/log.js';
import { config } from '../config.js';
import { pool, withTransaction } from '../db/pool.js';

function logoUrl(key: string | null): string | null {
  if (!key) return null;
  if (key.startsWith('http')) return key;
  return `${config.publicBaseUrl}/files/${key.replace(/^\/+/, '')}`;
}

export async function getProfile(bankId: string) {
  const { rows } = await pool.query<{
    id: string;
    name: string;
    slug: string;
    status: string;
    logo_object_key: string | null;
  }>(`SELECT id, name, slug, status, logo_object_key FROM banks WHERE id = $1`, [
    bankId,
  ]);
  const b = rows[0];
  if (!b) throw new AppError('not_found', 'Bank not found');
  return {
    id: b.id,
    name: b.name,
    slug: b.slug,
    status: b.status,
    logoUrl: logoUrl(b.logo_object_key),
  };
}

export async function patchProfile(bankId: string, name?: string) {
  if (name) {
    await pool.query(`UPDATE banks SET name = $1 WHERE id = $2`, [name, bankId]);
  }
  return getProfile(bankId);
}

export async function setLogoObjectKey(bankId: string, key: string) {
  await pool.query(`UPDATE banks SET logo_object_key = $1 WHERE id = $2`, [
    key,
    bankId,
  ]);
  return { logoUrl: logoUrl(key) };
}

export async function listApiKeys(bankId: string) {
  const { rows } = await pool.query(
    `SELECT id, key_prefix, label, scopes, created_at, revoked_at
     FROM api_credentials WHERE bank_id = $1 ORDER BY created_at DESC`,
    [bankId],
  );
  return {
    keys: rows.map((k) => ({
      id: k.id,
      keyPrefix: k.key_prefix,
      label: k.label,
      scopes: k.scopes,
      createdAt: k.created_at.toISOString(),
      revokedAt: k.revoked_at ? k.revoked_at.toISOString() : null,
    })),
  };
}

export async function createApiKey(
  bankId: string,
  actorUserId: string,
  input: { label?: string; scopes: string[] },
) {
  const { raw, prefix, hash } = apiKeyParts();
  const id = randomUUID();
  await withTransaction(async (tx) => {
    await tx.query(
      `INSERT INTO api_credentials (id, bank_id, key_prefix, key_hash, label, scopes)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [id, bankId, prefix, hash, input.label ?? null, input.scopes],
    );
    await writeAudit(tx, {
      actorUserId,
      bankId,
      action: 'api_key.created',
      entityType: 'api_credential',
      entityId: id,
    });
  });
  return { id, keyPrefix: prefix, apiKey: raw };
}

export async function revokeApiKey(bankId: string, keyId: string) {
  const res = await pool.query(
    `UPDATE api_credentials SET revoked_at = now()
     WHERE id = $1 AND bank_id = $2 AND revoked_at IS NULL`,
    [keyId, bankId],
  );
  if ((res.rowCount ?? 0) === 0) throw new AppError('not_found', 'API key not found');
}
