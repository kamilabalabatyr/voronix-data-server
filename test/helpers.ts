// Builds a fresh test database that looks exactly like the CRM's: the public
// tables, the demo business Barberista with its real demo data (dumped from
// the CRM's seed), and a second empty business to prove the data is separate.
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import pg from "pg";
import { loadConfig, type Config } from "../src/config.js";
import { createPool, migrateAll, schemaFor, type Pool } from "../src/db.js";
import { createApp } from "../src/app.js";
import { createKey } from "../src/auth.js";
import { ServerStore } from "../client/server-store.js";

export const BIZ_A = "23dcb12c-5e0e-42bb-beeb-2a4318abd8a5"; // Barberista (demo data)
export const BIZ_B = "0b0b0b0b-1111-4222-8333-444455556666"; // empty business
const fx = (f: string) => readFileSync(new URL(`./fixtures/${f}`, import.meta.url), "utf8");

export async function freshDatabase(url: string): Promise<void> {
  const u = new URL(url);
  const name = u.pathname.slice(1);
  u.pathname = "/postgres";
  const admin = new pg.Client({ connectionString: u.toString() });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  await admin.query(`CREATE DATABASE "${name}"`);
  await admin.end();

  const c = new pg.Client({ connectionString: url });
  await c.connect();
  await c.query(fx("crm_core.sql"));
  await c.query(`SET search_path = public`);
  await c.query(
    `INSERT INTO public.businesses (business_id, name, country, timezone, currency) VALUES
       ($1, 'Barberista', 'KZ', 'Asia/Almaty', 'KZT'), ($2, 'Empty Studio', 'KZ', 'Asia/Almaty', 'KZT')`,
    [BIZ_A, BIZ_B],
  );
  const tenant = fx("crm_tenant.sql");
  await c.query(tenant.replaceAll("__SCHEMA__", schemaFor(BIZ_A)));
  await c.query(fx("crm_demo_data.sql").replaceAll("__SCHEMA__", schemaFor(BIZ_A)));
  await c.query(tenant.replaceAll("__SCHEMA__", schemaFor(BIZ_B)));
  await c.query(`INSERT INTO "${schemaFor(BIZ_B)}".business_settings (id, name) VALUES (1, 'Empty Studio')`);
  await c.end();
}

export interface TestEnv {
  pool: Pool;
  config: Config;
  url: string;
  keyA: string;
  keyB: string;
  store: (key?: string) => ServerStore;
  api: (path: string, init?: RequestInit & { key?: string }) => Promise<{ status: number; body: any; text: string }>;
  sql: (q: string, params?: unknown[]) => Promise<any[]>;
  close: () => Promise<void>;
}

export async function startEnv(env: Partial<NodeJS.ProcessEnv> = {}): Promise<TestEnv> {
  const config = loadConfig({ ...process.env, CRM_SYNC: "loose", ...env });
  await freshDatabase(config.databaseUrl);
  const pool = createPool(config.databaseUrl);
  await migrateAll(pool);
  const keyA = (await createKey(pool, BIZ_A)).key;
  const keyB = (await createKey(pool, BIZ_B)).key;
  const server = createApp({ pool, config, log: process.env.DEBUG_SERVER ? (m, x) => console.error(m, x) : () => {} });
  await server.start();
  const http = server.app.listen(0);
  await new Promise((ok) => http.once("listening", ok));
  const url = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  const stores: ServerStore[] = [];
  return {
    pool,
    config,
    url,
    keyA,
    keyB,
    store(key = keyA) {
      const s = new ServerStore({ url, key });
      stores.push(s);
      return s;
    },
    async api(path, init = {}) {
      const { key = keyA, ...rest } = init;
      const res = await fetch(url + path, {
        ...rest,
        headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(rest.body ? { "Content-Type": "application/json" } : {}), ...(rest.headers ?? {}) },
      });
      const text = await res.text();
      let body: any = null;
      try {
        body = JSON.parse(text);
      } catch {
        /* not json */
      }
      return { status: res.status, body, text };
    },
    async sql(q, params = []) {
      const c = await pool.connect();
      try {
        await c.query(`SET search_path = "${schemaFor(BIZ_A)}", public`);
        return (await c.query(q, params)).rows;
      } finally {
        await c.query(`RESET search_path`).catch(() => {});
        c.release();
      }
    },
    async close() {
      stores.forEach((s) => s.close());
      http.closeAllConnections();
      await new Promise((ok) => http.close(ok));
      await server.stop();
      await pool.end();
    },
  };
}

export const until = async (check: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 20));
  }
};
