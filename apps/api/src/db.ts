import { readFileSync } from 'node:fs';

/** The tiny slice of a SQL client the API needs, so Postgres and PGlite are interchangeable. */
export interface Db {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  close(): Promise<void>;
}

const schema = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');

/**
 * DATABASE_URL starting with postgres:// uses a real Postgres server.
 * Anything else is a PGlite data directory ("memory://" for an in-memory database),
 * which needs no server and is handy for local development and tests.
 */
export async function createDb(url = process.env.DATABASE_URL ?? 'memory://'): Promise<Db> {
  let db: Db;
  if (/^postgres(ql)?:\/\//.test(url)) {
    const { default: pg } = await import('pg');
    const pool = new pg.Pool({ connectionString: url });
    db = {
      query: async (sql, params) => (await pool.query(sql, params as unknown[])).rows,
      close: () => pool.end(),
    };
  } else {
    const { PGlite } = await import('@electric-sql/pglite');
    const lite = new PGlite(url);
    db = {
      query: async <T>(sql: string, params?: unknown[]) => (await lite.query<T>(sql, params)).rows,
      close: () => lite.close(),
    };
    // PGlite's query() runs one statement at a time; exec() runs the whole schema file.
    await lite.exec(schema);
    return db;
  }
  await db.query(schema);
  return db;
}
