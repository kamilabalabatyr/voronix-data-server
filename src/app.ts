// The HTTP API. Two kinds of endpoints:
//  - /v1/store/...  the five methods of the AI's Store interface, so the AI
//                   switches from the site database to this server by
//                   swapping one class (client/server-store.ts);
//  - everything else: what the CRM pages and the team need on top of that
//                   (client cards and preferences, documents, search,
//                   training data export, CRM business profile).
import express, { type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import type { Config } from "./config.js";
import { Scoped, type Pool, type Tenant, findTenant } from "./db.js";
import { HttpError, badRequest, fromPg, notFound } from "./errors.js";
import { KeyCheck } from "./auth.js";
import { LiveHub, type LiveChange } from "./live.js";
import { COLLECTIONS, isCollection, storeAll, storeGet, storePatch, storePut, storeRemove, syncBusiness, type Collection, type Ctx, type Row } from "./collections.js";
import { addDocument, deleteDocument, listDocuments, search } from "./knowledge.js";
import { businessFromCrm } from "./crm.js";
import { markDistinct, mergeAccounts, normPhone, resolvePerson } from "./identity.js";

declare module "express-serve-static-core" {
  interface Request {
    tenant?: Tenant;
  }
}

export interface AppDeps {
  pool: Pool;
  config: Config;
  /** Start live changes (LISTEN). Tests that do not need them can turn it off. */
  live?: boolean;
  log?: (msg: string, extra?: unknown) => void;
}

export function createApp(deps: AppDeps) {
  const { pool, config } = deps;
  const log = deps.log ?? ((m: string, x?: unknown) => console.error(m, x ?? ""));
  const scoped = new Scoped(pool);
  const keys = new KeyCheck(pool);
  const tenants = new Map<string, Tenant>();
  const ctxRun = <T>(t: Tenant, fn: (ctx: Ctx) => Promise<T>) => scoped.run(t, (c) => fn({ c, tenant: t, config }));
  const hub = new LiveHub(
    config.databaseUrl,
    (t, col, id) => ctxRun(t, (ctx) => storeGet(ctx, col, id)),
    (schema) => tenants.get(schema),
    (e) => log("live changes error", e),
  );

  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "3mb" }));

  // CORS: the AI page runs in a browser on another address.
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && (config.corsOrigins.includes("*") || config.corsOrigins.includes(origin))) {
      res.setHeader("Access-Control-Allow-Origin", config.corsOrigins.includes("*") ? "*" : origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Business-Id");
      res.setHeader("Access-Control-Allow-Methods", "GET, PUT, PATCH, POST, DELETE, OPTIONS");
      res.setHeader("Access-Control-Max-Age", "600");
    }
    if (req.method === "OPTIONS") return void res.sendStatus(204);
    next();
  });

  app.get("/health", async (_req, res) => {
    await pool.query("SELECT 1");
    res.json({ ok: true });
  });

  // ---------------------------------------------------------------- auth
  const v1 = express.Router();
  v1.use(async (req, _res, next) => {
    const auth = req.headers.authorization ?? "";
    const key = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
    let tenant: Tenant | null = null;
    if (key) tenant = await keys.tenantFor(key);
    else if (config.allowNoAuth) {
      const id = String(req.headers["x-business-id"] ?? config.defaultBusinessId ?? "");
      tenant = id ? await findTenant(pool, id) : null;
      if (!tenant) throw badRequest("Local mode: send X-Business-Id or set DEFAULT_BUSINESS_ID");
    }
    if (!tenant) throw new HttpError(401, "unauthorized", "Send Authorization: Bearer <API key> (npm run key:create)");
    tenants.set(tenant.schema, tenant);
    req.tenant = tenant;
    next();
  });
  const run = <T>(req: Request, fn: (ctx: Ctx) => Promise<T>) => ctxRun(req.tenant!, fn);
  const col = (req: Request): Collection => {
    const c = String(req.params.col);
    if (!isCollection(c)) throw notFound(`Unknown collection ${c}. Known: ${COLLECTIONS.join(", ")}`);
    return c;
  };
  const body = (req: Request): Record<string, unknown> => {
    if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) throw badRequest("Send a JSON object");
    return req.body as Record<string, unknown>;
  };

  v1.get("/me", (req, res) => {
    const t = req.tenant!;
    res.json({ business: { id: t.id, name: t.name, timezone: t.timezone, currency: t.currency }, collections: COLLECTIONS });
  });

  // ---------------------------------------------------------------- Store interface
  v1.get("/watch", (req, res) => {
    const wanted = String(req.query.cols ?? COLLECTIONS.join(","))
      .split(",")
      .map((s) => s.trim())
      .filter(isCollection);
    if (!wanted.length) throw badRequest("cols: one or more of " + COLLECTIONS.join(", "));
    res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    res.write(`event: ready\ndata: ${JSON.stringify({ cols: wanted })}\n\n`);
    const stop = hub.subscribe({
      tenant: req.tenant!,
      cols: new Set(wanted),
      send: (changes: LiveChange[]) => res.write(`event: changes\ndata: ${JSON.stringify(changes)}\n\n`),
    });
    const beat = setInterval(() => res.write(`: ping\n\n`), 25_000);
    req.on("close", () => {
      clearInterval(beat);
      stop();
    });
  });

  v1.get("/store/:col", async (req, res) => {
    const c = col(req);
    res.json({ rows: await run(req, (ctx) => storeAll(ctx, c)) });
  });
  v1.get("/store/:col/:id", async (req, res) => {
    const c = col(req);
    const row = await run(req, (ctx) => storeGet(ctx, c, String(req.params.id)));
    if (!row) throw notFound(`${c}/${req.params.id} does not exist`);
    res.json({ row });
  });
  v1.put("/store/:col/:id", async (req, res) => {
    const c = col(req);
    const row = { ...body(req), id: String(req.params.id) } as Row;
    await run(req, (ctx) => storePut(ctx, c, row));
    res.json({ ok: true });
  });
  v1.patch("/store/:col/:id", async (req, res) => {
    const c = col(req);
    const row = await run(req, (ctx) => storePatch(ctx, c, String(req.params.id), body(req)));
    res.json({ ok: true, row });
  });
  v1.delete("/store/:col/:id", async (req, res) => {
    const c = col(req);
    await run(req, (ctx) => storeRemove(ctx, c, String(req.params.id)));
    res.json({ ok: true });
  });

  // ---------------------------------------------------------------- clients
  v1.get("/clients/:id/card", async (req, res) => {
    const id = String(req.params.id);
    const out = await run(req, async (ctx) => {
      const card = (await ctx.c.query(`SELECT * FROM ai_client_card WHERE id = $1`, [id])).rows[0];
      if (!card) throw notFound(`Client ${id} does not exist`);
      const preferences = (
        await ctx.c.query(`SELECT kind, value, weight, source, updated_at AS "updatedAt" FROM ai_client_preferences WHERE client_id = $1 ORDER BY kind, weight DESC, value`, [id])
      ).rows;
      const bookings = (await storeAll(ctx, "bookings")).filter((b) => b.client === id || (card.crm_client_id && b.client === card.crm_client_id));
      const crm = card.crm_client_id
        ? {
            client: (await ctx.c.query(`SELECT client_id AS id, display_name AS name, phone, notes FROM clients WHERE client_id = $1`, [card.crm_client_id])).rows[0] ?? null,
            channels: (await ctx.c.query(`SELECT messenger, external_user_id AS "externalUserId" FROM client_channels WHERE client_id = $1`, [card.crm_client_id])).rows,
          }
        : null;
      const person = (await storeGet(ctx, "clients", id))?.person ?? null;
      return { card, preferences, bookings, crm, person };
    });
    res.json(out);
  });

  v1.get("/clients/:id/messages", async (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit ?? 100) || 100, 1), 1000);
    const before = req.query.before ? new Date(Number(req.query.before)) : new Date("9999-01-01");
    const rows = await run(req, async (ctx) =>
      (
        await ctx.c.query(
          `SELECT message_id AS id, sender AS "from", text, labels, (extract(epoch FROM sent_at) * 1000)::bigint AS at
             FROM ai_messages WHERE client_id = $1 AND sent_at < $2 ORDER BY sent_at DESC, message_id DESC LIMIT $3`,
          [String(req.params.id), before, limit],
        )
      ).rows.reverse(),
    );
    res.json({ messages: rows });
  });

  const Pref = z.object({
    kind: z.enum(["service", "staff", "time", "language", "note"]),
    value: z.string().trim().min(1).max(200),
    source: z.enum(["stated", "staff"]).default("staff"),
    weight: z.number().int().min(0).max(1_000_000).default(1),
  });
  v1.post("/clients/:id/preferences", async (req, res) => {
    const p = Pref.safeParse(req.body);
    if (!p.success) throw badRequest("Bad preference", { issues: p.error.issues });
    const id = String(req.params.id);
    await run(req, async (ctx) => {
      const exists = await ctx.c.query(`SELECT 1 FROM ai_clients WHERE id = $1`, [id]);
      if (!exists.rowCount) throw notFound(`Client ${id} does not exist`);
      await ctx.c.query(
        `INSERT INTO ai_client_preferences (client_id, kind, value, weight, source) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (client_id, kind, value) DO UPDATE SET source = EXCLUDED.source, weight = EXCLUDED.weight, updated_at = now()`,
        [id, p.data.kind, p.data.value, p.data.weight, p.data.source],
      );
    });
    res.status(201).json({ ok: true });
  });
  v1.delete("/clients/:id/preferences/:kind/:value", async (req, res) => {
    const n = await run(req, async (ctx) =>
      (await ctx.c.query(`DELETE FROM ai_client_preferences WHERE client_id = $1 AND kind = $2 AND value = $3`, [String(req.params.id), String(req.params.kind), String(req.params.value)])).rowCount,
    );
    if (!n) throw notFound("No such preference");
    res.json({ ok: true });
  });

  // ---------------------------------------------------------------- one client, many messengers
  const exists = async (ctx: Ctx, id: string) => {
    if (!(await ctx.c.query(`SELECT 1 FROM ai_clients WHERE id = $1`, [id])).rowCount) throw notFound(`Client ${id} does not exist`);
  };
  const Other = z.object({ with: z.string().min(1).max(64) });

  /** The client wrote their phone: the same phone in another messenger or in the CRM is the same person. */
  v1.post("/clients/:id/phone", async (req, res) => {
    const phone = normPhone((req.body as { phone?: unknown })?.phone);
    if (!phone) throw badRequest("phone: a phone number, e.g. +7 700 123 45 67");
    const id = String(req.params.id);
    const out = await run(req, async (ctx) => {
      await exists(ctx, id);
      await ctx.c.query(`UPDATE ai_clients SET phone = $2, updated_at = now() WHERE id = $1`, [id, phone]);
      await resolvePerson(ctx.c, id);
      return (await storeGet(ctx, "clients", id))?.person ?? null;
    });
    res.json({ phone, person: out });
  });

  /** Accounts that are probably one person (same name, different messengers) for a person to check. */
  v1.get("/clients/duplicates", async (req, res) => {
    res.json({ candidates: await run(req, async (ctx) => (await ctx.c.query(`SELECT * FROM ai_duplicate_candidates ORDER BY client_a, client_b`)).rows) });
  });

  v1.post("/clients/:id/merge", async (req, res) => {
    const o = Other.safeParse(req.body);
    if (!o.success) throw badRequest("Send {\"with\": \"<other client id>\"}");
    const id = String(req.params.id);
    const crmClientId = await run(req, async (ctx) => {
      await exists(ctx, id);
      await exists(ctx, o.data.with);
      return mergeAccounts(ctx.c, id, o.data.with);
    });
    res.json({ ok: true, crmClientId });
  });

  v1.post("/clients/:id/not-same", async (req, res) => {
    const o = Other.safeParse(req.body);
    if (!o.success) throw badRequest("Send {\"with\": \"<other client id>\"}");
    const id = String(req.params.id);
    await run(req, async (ctx) => {
      await exists(ctx, id);
      await exists(ctx, o.data.with);
      await markDistinct(ctx.c, id, o.data.with);
    });
    res.json({ ok: true });
  });

  // ---------------------------------------------------------------- bookings
  v1.get("/calendar", async (req, res) => {
    const day = /^\d{4}-\d{2}-\d{2}$/;
    const from = String(req.query.from ?? "");
    const to = String(req.query.to ?? "");
    if ((from && !day.test(from)) || (to && !day.test(to))) throw badRequest("from and to look like 2026-11-06");
    const rows = (await run(req, (ctx) => storeAll(ctx, "bookings"))).filter((b) => {
      const d = String(b.start).slice(0, 10);
      return (!from || d >= from) && (!to || d <= to) && (!req.query.staff || b.staff === req.query.staff);
    });
    res.json({ bookings: rows });
  });

  // ---------------------------------------------------------------- knowledge
  v1.get("/knowledge/search", async (req, res) => {
    const q = String(req.query.q ?? "").trim();
    if (!q) throw badRequest("q is empty");
    res.json({ hits: await run(req, (ctx) => search(ctx.c, q, Number(req.query.limit ?? 5) || 5)) });
  });
  v1.get("/knowledge/documents", async (req, res) => {
    res.json({ documents: await run(req, (ctx) => listDocuments(ctx.c)) });
  });
  const Doc = z.object({
    title: z.string().trim().min(1).max(200),
    content: z.string().min(1).max(2_000_000),
    fileName: z.string().max(200).optional(),
    mime: z.string().max(100).optional(),
    source: z.enum(["business", "operator", "file"]).optional(),
    uploadedBy: z.string().max(80).optional(),
    tags: z.array(z.string().max(40)).max(20).optional(),
  });
  v1.post("/knowledge/documents", async (req, res) => {
    const d = Doc.safeParse(req.body);
    if (!d.success) throw badRequest("Bad document", { issues: d.error.issues });
    res.status(201).json(await run(req, (ctx) => addDocument(ctx.c, d.data)));
  });
  v1.delete("/knowledge/documents/:id", async (req, res) => {
    if (!(await run(req, (ctx) => deleteDocument(ctx.c, String(req.params.id))))) throw notFound("No such document");
    res.json({ ok: true });
  });

  // ---------------------------------------------------------------- training data
  v1.get("/training/phrases.tsv", async (req, res) => {
    const rows = await run(req, async (ctx) => (await ctx.c.query(`SELECT lang, labels, text FROM ai_training_set`)).rows);
    const flat = (s: string) => s.replace(/[\t\r\n]+/g, " ").trim();
    res.type("text/tab-separated-values; charset=utf-8");
    res.send(`# VoroniX AI phrases learned by ${req.tenant!.name}, ${new Date().toISOString()}\nlang\tlabels\ttext\n${rows.map((r) => `${r.lang}\t${r.labels}\t${flat(r.text)}`).join("\n")}\n`);
  });
  v1.get("/training/phrases.jsonl", async (req, res) => {
    const rows = await run(req, async (ctx) => (await ctx.c.query(`SELECT text, lang, labels, source, learned_at FROM ai_phrases ORDER BY learned_at, id`)).rows);
    res.type("application/x-ndjson; charset=utf-8");
    res.send(rows.map((r) => JSON.stringify({ ...r, labels: r.labels })).join("\n") + (rows.length ? "\n" : ""));
  });

  // ---------------------------------------------------------------- CRM
  v1.get("/crm/business", async (req, res) => {
    res.json({ business: await run(req, (ctx) => businessFromCrm(ctx.c, ctx.tenant)) });
  });
  v1.post("/crm/business/sync", async (req, res) => {
    res.json({ business: await run(req, (ctx) => syncBusiness(ctx)) });
  });

  v1.get("/stats", async (req, res) => {
    const out = await run(req, async (ctx) => {
      const tables = ["ai_clients", "ai_client_preferences", "ai_messages", "ai_bookings", "ai_knowledge_documents", "ai_knowledge", "ai_phrases", "ai_review_queue", "ai_model_versions", "ai_events", "ai_settings"];
      const counts: Record<string, number> = {};
      for (const t of tables) counts[t] = Number((await ctx.c.query(`SELECT count(*) AS n FROM ${t}`)).rows[0].n);
      const sync = (await ctx.c.query(`SELECT sync_status, count(*)::int AS n FROM ai_bookings GROUP BY sync_status`)).rows;
      const bytes = Number(
        (await ctx.c.query(`SELECT coalesce(sum(pg_total_relation_size(format('%I.%I', schemaname, tablename))), 0) AS b FROM pg_tables WHERE schemaname = $1 AND tablename LIKE 'ai\\_%'`, [ctx.tenant.schema])).rows[0].b,
      );
      return { counts, bookingSync: Object.fromEntries(sync.map((r) => [r.sync_status, r.n])), bytes };
    });
    res.json(out);
  });

  app.use("/v1", v1);

  app.use((_req, _res, next) => next(notFound("No such endpoint")));
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const e = err instanceof HttpError ? err : fromPg(err);
    if (e) return void res.status(e.status).json({ error: { code: e.code, message: e.message, ...(e.details ?? {}) } });
    if ((err as { type?: string })?.type === "entity.parse.failed") return void res.status(400).json({ error: { code: "bad_json", message: "Body is not valid JSON" } });
    log("unexpected error", err);
    res.status(500).json({ error: { code: "internal", message: "Something went wrong on the server" } });
  });

  return {
    app,
    hub,
    async start() {
      if (deps.live !== false) await hub.start();
    },
    async stop() {
      await hub.stop();
    },
  };
}
