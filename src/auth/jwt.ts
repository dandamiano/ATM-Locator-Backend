import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { AppError } from '../http/errors.js';

export type Role =
  | 'bank_admin'
  | 'bank_operator'
  | 'queue_reporter'
  | 'platform_admin'
  | 'platform_analyst';

export type JwtClaims = {
  sub: string;
  role: Role;
  bank_id?: string | null;
  exp?: number;
};

export type AuthUser = {
  id: string;
  role: Role;
  bankId: string | null;
  displayName?: string;
};

export function signAccessToken(user: AuthUser): {
  accessToken: string;
  expiresIn: number;
} {
  const expiresIn = config.jwtExpiresSec;
  const payload: JwtClaims = {
    sub: user.id,
    role: user.role,
    bank_id: user.bankId,
  };
  const accessToken = jwt.sign(payload, config.jwtSecret, { expiresIn });
  return { accessToken, expiresIn };
}

export function verifyAccessToken(token: string): AuthUser {
  try {
    const decoded = jwt.verify(token, config.jwtSecret) as JwtClaims;
    return {
      id: decoded.sub,
      role: decoded.role,
      bankId: decoded.bank_id ?? null,
    };
  } catch {
    throw new AppError('unauthorized', 'Invalid or expired token');
  }
}
