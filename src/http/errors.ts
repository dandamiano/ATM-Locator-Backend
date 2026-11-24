export type ErrorCode =
  | 'validation_error'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'rate_limited'
  | 'internal_error';

const statusByCode: Record<ErrorCode, number> = {
  validation_error: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  rate_limited: 429,
  internal_error: 500,
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;
  readonly details?: Record<string, unknown>;
  readonly retryAfter?: number;

  constructor(
    code: ErrorCode,
    message: string,
    details?: Record<string, unknown>,
    retryAfter?: number,
  ) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.statusCode = statusByCode[code];
    this.details = details;
    this.retryAfter = retryAfter;
  }
}

export function errorBody(err: AppError) {
  return {
    error: {
      code: err.code,
      message: err.message,
      ...(err.details ? { details: err.details } : {}),
    },
  };
}
