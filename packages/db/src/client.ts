import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema';

export type Db = NodePgDatabase<typeof schema>;

let pool: pg.Pool | undefined;
let db: Db | undefined;

export function getPool(url = process.env.DATABASE_URL): pg.Pool {
  if (!url) throw new Error('DATABASE_URL is not set');
  if (!pool) {
    pool = new pg.Pool({
      connectionString: url,
      max: Number(process.env.DB_POOL_MAX ?? 8),
      ssl: /render\.com|sslmode=require/.test(url) ? { rejectUnauthorized: false } : undefined,
    });
  }
  return pool;
}

export function getDb(url?: string): Db {
  if (!db) db = drizzle(getPool(url), { schema });
  return db;
}

export async function closeDb(): Promise<void> {
  await pool?.end();
  pool = undefined;
  db = undefined;
}

export { schema };
