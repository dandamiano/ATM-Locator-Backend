/**
 * @module db/pool
 * @layer infra
 * @description PostgreSQL connection pool and transactional helper.
 */

import pg from 'pg';
import { config } from '../config.js';

const { Pool } = pg;

export const pool = new Pool({
  connectionString: config.databaseUrl,
});

export type DbClient = pg.PoolClient | pg.Pool;

/**
 * Runs work in a single DB transaction.
 * Use for any multi-step write that must commit or roll back together.
 */
export async function withTransaction<T>(
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
