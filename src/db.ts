// Database access: one pool, transactions, and the business scope. Every query
// for a business runs in a transaction whose search_path points at that
// business's schema (t_<id>), the same way the CRM does it, so a query can
// never touch another business's rows.
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

// BIGINT and NUMERIC come back as numbers (all our values fit).
pg.types.setTypeParser(20, (v) => Number(v));
pg.types.setTypeParser(1700, (v) => Number(v));

export type Pool = pg.Pool;
export type Client = pg.PoolClient;

export interface Tenant {
  id: string;
  schema: string;
  name: string;
  timezone: string;
  currency: string;
}

const SCHEMA_RE = /^t_[0-9a-f]{32}$/;
export const schemaFor = (businessId: string) => `t_${businessId.replace(/-/g, "").toLowerCase()}`;

export function createPool(url: string): Pool {
  return new pg.Pool({ connectionString: url, max: 10 });
}

export async function tx<T>(pool: Pool, fn: (c: Client) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const out = await fn(c);
    await c.query("COMMIT");
    return out;
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

/** Points the rest of this transaction at one business schema. */
export async function scopeTo(c: Client, schema: string): Promise<void> {
  if (!SCHEMA_RE.test(schema)) throw new Error(`Bad business schema name: ${schema}`);
  await c.query(`SELECT set_config('search_path', $1, true)`, [`"${schema}", public`]);
}

// ------------------------------------------------------------------ migrations

const here = path.dirname(fileURLToPath(import.meta.url));
/** Works from src/ (tsx) and from dist/src/ (built). */
async function migrationsDir(): Promise<string> {
  for (const p of [path.resolve(here, "../db/migrations"), path.resolve(here, "../../db/migrations")]) {
    try {
      await readdir(p);
      return p;
    } catch {
      /* next */
    }
  }
  throw new Error("db/migrations not found");
}

async function files(dir: string): Promise<string[]> {
  return (await readdir(dir)).filter((f) => /^\d{3}_.+\.sql$/.test(f)).sort();
}

/** public.ai_api_keys and public.ai_notify(), once per database. */
export async function migrateCore(pool: Pool): Promise<string[]> {
  const dir = path.join(await migrationsDir(), "core");
  return tx(pool, async (c) => {
    await c.query(`SELECT pg_advisory_xact_lock(hashtext('voronix-data-core'))`);
    await c.query(`CREATE TABLE IF NOT EXISTS public.ai_core_migrations (file TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    const done = new Set((await c.query<{ file: string }>(`SELECT file FROM public.ai_core_migrations`)).rows.map((r) => r.file));
    const applied: string[] = [];
    for (const f of await files(dir)) {
      if (done.has(f)) continue;
      await c.query(await readFile(path.join(dir, f), "utf8"));
      await c.query(`INSERT INTO public.ai_core_migrations (file) VALUES ($1)`, [f]);
      applied.push(`core/${f}`);
    }
    return applied;
  });
}

/** The ai_* tables inside one business schema. Safe to run many times and from many processes. */
export async function migrateTenant(c: Client, schema: string): Promise<string[]> {
  const dir = path.join(await migrationsDir(), "tenant");
  await scopeTo(c, schema);
  await c.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`voronix-data:${schema}`]);
  await c.query(`CREATE TABLE IF NOT EXISTS ai_migrations (file TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  const done = new Set((await c.query<{ file: string }>(`SELECT file FROM ai_migrations`)).rows.map((r) => r.file));
  const applied: string[] = [];
  for (const f of await files(dir)) {
    if (done.has(f)) continue;
    await c.query(await readFile(path.join(dir, f), "utf8"));
    await c.query(`INSERT INTO ai_migrations (file) VALUES ($1)`, [f]);
    applied.push(`${schema}/${f}`);
  }
  return applied;
}

export async function listTenants(pool: Pool): Promise<Tenant[]> {
  const rows = (
    await pool.query<{ id: string; name: string; timezone: string; currency: string }>(
      `SELECT business_id AS id, name, timezone, currency FROM public.businesses ORDER BY created_at`,
    )
  ).rows;
  return rows.map((r) => ({ ...r, schema: schemaFor(r.id) }));
}

export async function findTenant(pool: Pool, id: string): Promise<Tenant | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const r = (
    await pool.query<{ id: string; name: string; timezone: string; currency: string }>(
      `SELECT business_id AS id, name, timezone, currency FROM public.businesses WHERE business_id = $1`,
      [id],
    )
  ).rows[0];
  return r ? { ...r, schema: schemaFor(r.id) } : null;
}

/** Runs core migrations and the tenant migrations of every business. */
export async function migrateAll(pool: Pool): Promise<string[]> {
  const out = await migrateCore(pool);
  for (const t of await listTenants(pool)) out.push(...(await tx(pool, (c) => migrateTenant(c, t.schema))));
  return out;
}

/**
 * Runs fn inside a transaction scoped to one business. The first call for a
 * business also builds its AI tables, so businesses that sign up in the CRM
 * after this server started work at once.
 */
export class Scoped {
  private ready = new Set<string>();
  constructor(readonly pool: Pool) {}

  async run<T>(t: Tenant, fn: (c: Client) => Promise<T>): Promise<T> {
    if (!this.ready.has(t.schema)) {
      await tx(this.pool, (c) => migrateTenant(c, t.schema));
      this.ready.add(t.schema);
    }
    return tx(this.pool, async (c) => {
      await scopeTo(c, t.schema);
      return fn(c);
    });
  }
}
