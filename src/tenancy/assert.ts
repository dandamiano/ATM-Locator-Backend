/**
 * @module tenancy/assert
 * @layer tenancy
 * @description Tenant ownership checks for bank-scoped resources.
 */

import { AppError } from '../http/errors.js';
import type { AuthUser } from '../auth/jwt.js';

/** Platform roles may cross tenants; bank roles may only touch their bank_id. */
export function assertBankAccess(user: AuthUser, bankId: string): void {
  if (user.role === 'platform_admin' || user.role === 'platform_analyst') {
    return;
  }
  if (user.bankId !== bankId) {
    throw new AppError('forbidden', 'Tenant isolation violation');
  }
}

/** Requires a bank-scoped caller with a non-null bankId. */
export function requireBankId(user: AuthUser): string {
  if (!user.bankId) {
    throw new AppError('forbidden', 'Bank tenancy required');
  }
  return user.bankId;
}
