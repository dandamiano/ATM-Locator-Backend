/**
 * @module services/users
 * @layer service
 * @description Bank user CRUD (PIN required for queue_reporter).
 */

import { hashSecret } from '../auth/crypto.js';
import { AppError } from '../http/errors.js';
import { pool } from '../db/pool.js';
import * as usersQ from '../db/queries/users.js';

export async function listUsers(bankId: string) {
  const rows = await usersQ.listBankUsers(pool, bankId);
  return { users: rows.map(usersQ.toUserDto) };
}

export async function getUser(bankId: string, userId: string) {
  const u = await usersQ.getBankUser(pool, userId, bankId);
  if (!u) throw new AppError('not_found', 'User not found');
  return usersQ.toUserDto(u);
}

export async function createUser(
  bankId: string,
  body: {
    email?: string;
    employeeId?: string;
    displayName?: string;
    role: 'bank_admin' | 'bank_operator' | 'queue_reporter';
    password: string;
    pin?: string;
  },
) {
  if (body.role === 'queue_reporter' && !body.pin) {
    throw new AppError('validation_error', 'PIN required for queue_reporter');
  }
  const passwordHash = await hashSecret(body.password);
  const pinHash = body.pin ? await hashSecret(body.pin) : null;
  return usersQ.createBankUser(pool, {
    bankId,
    role: body.role,
    email: body.email,
    employeeId: body.employeeId,
    displayName: body.displayName,
    passwordHash,
    pinHash,
  });
}

export async function patchUser(
  bankId: string,
  userId: string,
  body: {
    displayName?: string;
    role?: 'bank_admin' | 'bank_operator' | 'queue_reporter';
    status?: 'active' | 'disabled';
    password?: string;
    pin?: string;
  },
) {
  const existing = await usersQ.getBankUser(pool, userId, bankId);
  if (!existing) throw new AppError('not_found', 'User not found');
  const updated = await usersQ.updateBankUser(pool, userId, bankId, {
    displayName: body.displayName,
    role: body.role,
    status: body.status,
    passwordHash: body.password ? await hashSecret(body.password) : undefined,
    pinHash: body.pin ? await hashSecret(body.pin) : undefined,
  });
  return usersQ.toUserDto(updated!);
}

export async function deactivateUser(bankId: string, userId: string) {
  const ok = await usersQ.deactivateBankUser(pool, userId, bankId);
  if (!ok) throw new AppError('not_found', 'User not found');
}
