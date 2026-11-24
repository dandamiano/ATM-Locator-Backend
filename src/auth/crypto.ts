import { createHash, randomBytes } from 'node:crypto';
import argon2 from 'argon2';

export async function hashSecret(value: string): Promise<string> {
  return argon2.hash(value, { type: argon2.argon2id });
}

export async function verifySecret(hash: string, value: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, value);
  } catch {
    return false;
  }
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function apiKeyParts(): { raw: string; prefix: string; hash: string } {
  const raw = `atl_${randomBytes(24).toString('hex')}`;
  const prefix = raw.slice(0, 12);
  return { raw, prefix, hash: sha256Hex(raw) };
}
