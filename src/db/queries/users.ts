/**
 * @module db/queries/users
 * @layer query
 * @description Typed SQL accessors for bank/platform users.
 */

import { randomUUID } from 'node:crypto';
import type { DbClient } from '../pool.js';

export type UserRow = {
  id: string;
  email: string | null;
  employee_id: string | null;
  display_name: string;
  role: string;
  status: string;
};

export function toUserDto(u: UserRow) {
  return {
    id: u.id,
    email: u.email,
    employeeId: u.employee_id,
    displayName: u.display_name,
    role: u.role,
    status: u.status,
  };
}

export async function listBankUsers(db: DbClient, bankId: string) {
  const { rows } = await db.query<UserRow>(
    `SELECT id, email, employee_id, display_name, role, status
     FROM users WHERE bank_id = $1
     ORDER BY display_name`,
    [bankId],
  );
  return rows;
}

export async function getBankUser(db: DbClient, userId: string, bankId: string) {
  const { rows } = await db.query<UserRow>(
    `SELECT id, email, employee_id, display_name, role, status
     FROM users WHERE id = $1 AND bank_id = $2`,
    [userId, bankId],
  );
  return rows[0] ?? null;
}

export async function createBankUser(
  db: DbClient,
  input: {
    bankId: string;
    role: string;
    email?: string;
    employeeId?: string;
    displayName?: string;
    passwordHash: string;
    pinHash: string | null;
  },
) {
  const id = randomUUID();
  const displayName =
    input.displayName ?? input.employeeId ?? input.email ?? 'User';
  await db.query(
    `INSERT INTO users (id, bank_id, role, email, employee_id, display_name, password_hash, pin_hash, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'active')`,
    [
      id,
      input.bankId,
      input.role,
      input.email ?? null,
      input.employeeId ?? null,
      displayName,
      input.passwordHash,
      input.pinHash,
    ],
  );
  return {
    id,
    email: input.email ?? null,
    employeeId: input.employeeId ?? null,
    displayName,
    role: input.role,
    status: 'active',
  };
}

export async function updateBankUser(
  db: DbClient,
  userId: string,
  bankId: string,
  patch: {
    displayName?: string;
    role?: string;
    status?: string;
    passwordHash?: string;
    pinHash?: string;
  },
) {
  const sets: string[] = [];
  const params: unknown[] = [];
  const push = (col: string, val: unknown) => {
    params.push(val);
    sets.push(`${col} = $${params.length}`);
  };
  if (patch.displayName != null) push('display_name', patch.displayName);
  if (patch.role != null) push('role', patch.role);
  if (patch.status != null) push('status', patch.status);
  if (patch.passwordHash) push('password_hash', patch.passwordHash);
  if (patch.pinHash) push('pin_hash', patch.pinHash);
  if (!sets.length) return getBankUser(db, userId, bankId);

  params.push(userId, bankId);
  await db.query(
    `UPDATE users SET ${sets.join(', ')}
     WHERE id = $${params.length - 1} AND bank_id = $${params.length}`,
    params,
  );
  return getBankUser(db, userId, bankId);
}

export async function deactivateBankUser(
  db: DbClient,
  userId: string,
  bankId: string,
) {
  const res = await db.query(
    `UPDATE users SET status = 'disabled' WHERE id = $1 AND bank_id = $2`,
    [userId, bankId],
  );
  return (res.rowCount ?? 0) > 0;
}
