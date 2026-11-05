// The 8 collections the AI reads and writes through its Store interface
// (voronix-ai/src/live/store.ts), each mapped to real tables. A row goes in
// as the AI's JSON object and comes back as the same object: fields we know get
// typed, checked columns; any other field is kept in the row's extra JSONB.
import type { Client, Tenant } from "./db.js";
import type { Config } from "./config.js";
import { badRequest, conflict, notFound } from "./errors.js";
import { businessFromCrm, syncBooking, updateCrmVisit, type AiBusiness } from "./crm.js";
import { normPhone, phoneInText, phoneOfHandle, resolvePerson } from "./identity.js";

export const COLLECTIONS = ["phrases", "queue", "knowledge", "clients", "bookings", "versions", "events", "settings"] as const;
export type Collection = (typeof COLLECTIONS)[number];
export type Row = { id: string } & Record<string, unknown>;

export const isCollection = (c: string): c is Collection => (COLLECTIONS as readonly string[]).includes(c);

export interface Ctx {
  c: Client;
  tenant: Tenant;
  config: Config;
}

interface Mapping {
  all(ctx: Ctx): Promise<Row[]>;
  get(ctx: Ctx, id: string): Promise<Row | null>;
  put(ctx: Ctx, row: Row): Promise<void>;
  remove(ctx: Ctx, id: string): Promise<void>;
  /** Locks the row for a patch (read, merge, write). */
  lock?(ctx: Ctx, id: string): Promise<void>;
}

// ------------------------------------------------------------------ helpers

const ms = (d: Date | null | undefined) => (d instanceof Date ? d.getTime() : undefined);
const date = (v: unknown, fallback = Date.now()) => new Date(typeof v === "number" && Number.isFinite(v) ? v : fallback);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const arr = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
const str = (v: unknown, d = "") => (typeof v === "string" ? v : v == null ? d : String(v));
const num = (v: unknown, d = 0) => (typeof v === "number" && Number.isFinite(v) ? v : d);

/** Fields of row not in known, for the extra JSONB column. */
function rest(row: Row, known: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) if (!known.includes(k) && v !== undefined) out[k] = v;
  return out;
}

/** Drops undefined and null optional fields so a row reads back exactly as it was written. */
function clean(o: Record<string, unknown>, optional: string[]): Row {
  for (const k of optional) if (o[k] === null || o[k] === undefined) delete o[k];
  return o as Row;
}

const one = async (ctx: Ctx, sql: string, id: string) => (await ctx.c.query(sql, [id])).rows[0] ?? null;

export function deepMerge(into: Record<string, unknown>, data: Record<string, unknown>): Record<string, unknown> {
  const out = { ...into };
  for (const [k, v] of Object.entries(data)) {
    const cur = out[k];
    out[k] = v && typeof v === "object" && !Array.isArray(v) && cur && typeof cur === "object" && !Array.isArray(cur) ? deepMerge(cur as Record<string, unknown>, v as Record<string, unknown>) : v;
  }
  return out;
}

// ------------------------------------------------------------------ phrases

const PHRASE = ["id", "text", "lang", "labels", "source", "why", "at", "client"] as const;
const phraseRow = (r: Record<string, any>): Row =>
  clean({ ...r.extra, id: r.id, text: r.text, lang: r.lang, labels: r.labels, source: r.source, why: r.why, at: ms(r.learned_at), client: r.client_id }, ["client"]);

const phrases: Mapping = {
  async all({ c }) {
    return (await c.query(`SELECT * FROM ai_phrases ORDER BY learned_at, id`)).rows.map(phraseRow);
  },
  async get(ctx, id) {
    const r = await one(ctx, `SELECT * FROM ai_phrases WHERE id = $1`, id);
    return r && phraseRow(r);
  },
  async lock(ctx, id) {
    await ctx.c.query(`SELECT 1 FROM ai_phrases WHERE id = $1 FOR UPDATE`, [id]);
  },
  async put({ c }, p) {
    await c.query(
      `INSERT INTO ai_phrases (id, text, lang, labels, source, why, client_id, learned_at, extra)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (id) DO UPDATE SET text = EXCLUDED.text, lang = EXCLUDED.lang, labels = EXCLUDED.labels, source = EXCLUDED.source,
         why = EXCLUDED.why, client_id = EXCLUDED.client_id, learned_at = EXCLUDED.learned_at, extra = EXCLUDED.extra`,
      [p.id, str(p.text), str(p.lang), arr(p.labels), str(p.source), str(p.why), p.client ?? null, date(p.at), rest(p, PHRASE)],
    );
  },
  async remove({ c }, id) {
    await c.query(`DELETE FROM ai_phrases WHERE id = $1`, [id]);
  },
};

// ------------------------------------------------------------------ queue

const QUEUE = ["id", "kind", "text", "lang", "guess", "score", "client", "clientName", "channel", "at"] as const;
const queueRow = (r: Record<string, any>): Row =>
  clean(
    { ...r.extra, id: r.id, kind: r.kind, text: r.text, lang: r.lang, guess: r.guess, score: r.score, client: r.client_id, clientName: r.client_name, channel: r.channel, at: ms(r.created_at) },
    ["client", "clientName", "channel"],
  );

const queue: Mapping = {
  async all({ c }) {
    return (await c.query(`SELECT * FROM ai_review_queue ORDER BY created_at, id`)).rows.map(queueRow);
  },
  async get(ctx, id) {
    const r = await one(ctx, `SELECT * FROM ai_review_queue WHERE id = $1`, id);
    return r && queueRow(r);
  },
  async lock(ctx, id) {
    await ctx.c.query(`SELECT 1 FROM ai_review_queue WHERE id = $1 FOR UPDATE`, [id]);
  },
  async put({ c }, q) {
    await c.query(
      `INSERT INTO ai_review_queue (id, kind, text, lang, guess, score, client_id, client_name, channel, created_at, extra)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (id) DO UPDATE SET kind = EXCLUDED.kind, text = EXCLUDED.text, lang = EXCLUDED.lang, guess = EXCLUDED.guess,
         score = EXCLUDED.score, client_id = EXCLUDED.client_id, client_name = EXCLUDED.client_name, channel = EXCLUDED.channel,
         created_at = EXCLUDED.created_at, extra = EXCLUDED.extra`,
      [q.id, str(q.kind), str(q.text), str(q.lang), arr(q.guess), num(q.score), q.client ?? null, q.clientName ?? null, q.channel ?? null, date(q.at), rest(q, QUEUE)],
    );
  },
  async remove({ c }, id) {
    await c.query(`DELETE FROM ai_review_queue WHERE id = $1`, [id]);
  },
};

// ------------------------------------------------------------------ knowledge
// AI entries plus the entries typed on the CRM's "AI knowledge" page (ids KB-…).

const KNOW = ["id", "title", "text", "source", "file", "at", "documentId", "tags", "origin"] as const;
const knowRow = (r: Record<string, any>): Row =>
  clean(
    {
      ...(r.extra ?? {}),
      id: r.id,
      title: r.title,
      text: r.text,
      source: r.source,
      file: r.file,
      at: ms(r.created_at),
      ...(r.document_id ? { documentId: r.document_id } : {}),
      ...(r.tags?.length ? { tags: r.tags } : {}),
      ...(r.origin === "crm" ? { origin: "crm" } : {}),
    },
    ["file"],
  );
const CRM_KB = `SELECT entry_id AS id, title, content AS text, 'business' AS source, NULL AS file, updated_at AS created_at, NULL::text[] AS tags,
                       NULL AS document_id, '{}'::jsonb AS extra, 'crm' AS origin FROM knowledge_entries`;
const isCrmKb = (id: string) => /^KB-\d+$/.test(id);

const knowledge: Mapping = {
  async all({ c }) {
    const ai = (await c.query(`SELECT *, 'ai' AS origin FROM ai_knowledge ORDER BY created_at, id`)).rows;
    const crm = (await c.query(`${CRM_KB} ORDER BY updated_at, entry_id`)).rows;
    return [...crm, ...ai].map(knowRow);
  },
  async get(ctx, id) {
    const r = isCrmKb(id) ? await one(ctx, `${CRM_KB} WHERE entry_id = $1`, id) : await one(ctx, `SELECT *, 'ai' AS origin FROM ai_knowledge WHERE id = $1`, id);
    return r && knowRow(r);
  },
  async lock(ctx, id) {
    if (isCrmKb(id)) await ctx.c.query(`SELECT 1 FROM knowledge_entries WHERE entry_id = $1 FOR UPDATE`, [id]);
    else await ctx.c.query(`SELECT 1 FROM ai_knowledge WHERE id = $1 FOR UPDATE`, [id]);
  },
  async put({ c }, k) {
    if (isCrmKb(k.id)) {
      const r = await c.query(`UPDATE knowledge_entries SET title = $2, content = $3, updated_at = now() WHERE entry_id = $1`, [k.id, str(k.title).slice(0, 120), str(k.text)]);
      if (!r.rowCount) throw badRequest(`${k.id} looks like a CRM knowledge entry but the CRM has no such entry`);
      return;
    }
    await c.query(
      `INSERT INTO ai_knowledge (id, document_id, title, text, source, file, tags, created_at, extra)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (id) DO UPDATE SET document_id = EXCLUDED.document_id, title = EXCLUDED.title, text = EXCLUDED.text,
         source = EXCLUDED.source, file = EXCLUDED.file, tags = EXCLUDED.tags, created_at = EXCLUDED.created_at, extra = EXCLUDED.extra`,
      [k.id, k.documentId ?? null, str(k.title).slice(0, 200), str(k.text), str(k.source, "business"), k.file ?? null, arr(k.tags), date(k.at), rest(k, KNOW)],
    );
  },
  async remove({ c }, id) {
    if (isCrmKb(id)) throw conflict(`${id} lives in the CRM: delete it on the CRM's AI knowledge page`);
    await c.query(`DELETE FROM ai_knowledge WHERE id = $1`, [id]);
  },
};

// ------------------------------------------------------------------ clients
// ai_clients + ai_client_preferences (services, staff, times, language, notes)
// + ai_messages (history: the AI keeps the last 14, the database keeps all).

const CLIENT = ["id", "name", "channel", "handle", "lang", "first", "last", "messages", "intents", "services", "staff", "times", "bookings", "cancels", "complaints", "thanks", "mood", "history", "dialog", "notes", "crmClientId", "phone", "person"] as const;
const HISTORY = 14;

async function readClients(c: Client, where: string, params: unknown[]): Promise<Row[]> {
  const list = (await c.query(`SELECT * FROM ai_clients ${where} ORDER BY first_seen, id`, params)).rows;
  if (!list.length) return [];
  const ids = list.map((r) => r.id);
  const prefs = (await c.query(`SELECT client_id, kind, value, weight, source FROM ai_client_preferences WHERE client_id = ANY($1) ORDER BY updated_at, value`, [ids])).rows;
  const hist = (
    await c.query(
      `SELECT client_id, sender, text, labels, sent_at FROM (
         SELECT *, row_number() OVER (PARTITION BY client_id ORDER BY sent_at DESC, message_id DESC) AS n
           FROM ai_messages WHERE client_id = ANY($1)) h
        WHERE n <= ${HISTORY} ORDER BY sent_at, message_id`,
      [ids],
    )
  ).rows;
  const persons = await readPersons(c, [...new Set(list.map((r) => r.crm_client_id).filter(Boolean))]);
  return list.map((r) => {
    const mine = prefs.filter((p) => p.client_id === r.id);
    const map = (kind: string) => Object.fromEntries(mine.filter((p) => p.kind === kind).map((p) => [p.value, p.weight]));
    const t = map("time");
    const notes = mine.filter((p) => p.kind === "note").map((p) => p.value);
    return {
      ...r.extra,
      id: r.id,
      name: r.name,
      channel: r.channel,
      handle: r.handle,
      lang: r.lang,
      first: ms(r.first_seen),
      last: ms(r.last_seen),
      messages: r.messages,
      intents: r.intents,
      services: map("service"),
      staff: map("staff"),
      times: { morning: t.morning ?? 0, day: t.day ?? 0, evening: t.evening ?? 0 },
      bookings: r.bookings,
      cancels: r.cancels,
      complaints: r.complaints,
      thanks: r.thanks,
      mood: r.mood,
      history: hist.filter((h) => h.client_id === r.id).map((h) => clean({ at: ms(h.sent_at), from: h.sender, text: h.text, labels: h.labels }, ["labels"])),
      dialog: r.dialog,
      ...(notes.length ? { notes } : {}),
      ...(r.crm_client_id ? { crmClientId: r.crm_client_id } : {}),
      ...(r.phone ? { phone: r.phone } : {}),
      ...(r.crm_client_id && persons.has(r.crm_client_id) ? { person: persons.get(r.crm_client_id) } : {}),
    } as Row;
  });
}

/**
 * The person behind each CRM card: every messenger account of it and what
 * all of them together say about the client. The AI's own fields stay per
 * account; this is read-only and is not saved back.
 */
async function readPersons(c: Client, crmIds: string[]): Promise<Map<string, Record<string, unknown>>> {
  const out = new Map<string, Record<string, unknown>>();
  if (!crmIds.length) return out;
  const cards = (await c.query(`SELECT client_id, display_name, phone FROM clients WHERE client_id = ANY($1)`, [crmIds])).rows;
  const accounts = (await c.query(`SELECT id, channel, handle, crm_client_id FROM ai_clients WHERE crm_client_id = ANY($1) ORDER BY first_seen, id`, [crmIds])).rows;
  const channels = (await c.query(`SELECT client_id, lower(messenger) AS channel, external_user_id AS handle FROM client_channels WHERE client_id = ANY($1) ORDER BY channel_id`, [crmIds])).rows;
  const prefs = (
    await c.query(
      `SELECT a.crm_client_id, p.kind, p.value, sum(p.weight)::int AS weight
         FROM ai_client_preferences p JOIN ai_clients a ON a.id = p.client_id
        WHERE a.crm_client_id = ANY($1) GROUP BY 1, 2, 3 ORDER BY 1, 2, 4 DESC, 3`,
      [crmIds],
    )
  ).rows;
  const visits = (
    await c.query(`SELECT client_id, count(*)::int AS n FROM appointments WHERE client_id = ANY($1) AND status NOT IN ('Cancelled') GROUP BY 1`, [crmIds])
  ).rows;
  for (const card of cards) {
    const id = card.client_id;
    const mine = prefs.filter((p) => p.crm_client_id === id);
    const map = (kind: string) => Object.fromEntries(mine.filter((p) => p.kind === kind).map((p) => [p.value, p.weight]));
    const t = map("time");
    out.set(id, {
      crmClientId: id,
      name: card.display_name,
      ...(card.phone ? { phone: normPhone(card.phone) ?? card.phone } : {}),
      accounts: accounts.filter((a) => a.crm_client_id === id).map((a) => ({ id: a.id, channel: a.channel, handle: a.handle })),
      channels: channels.filter((ch) => ch.client_id === id).map((ch) => ({ channel: ch.channel, handle: ch.handle })),
      services: map("service"),
      staff: map("staff"),
      times: { morning: t.morning ?? 0, day: t.day ?? 0, evening: t.evening ?? 0 },
      notes: mine.filter((p) => p.kind === "note").map((p) => p.value),
      visits: visits.find((v) => v.client_id === id)?.n ?? 0,
    });
  }
  return out;
}

async function writeClient(c: Client, m: Row): Promise<void> {
  const first = date(m.first);
  const last = date(m.last, first.getTime());
  const channel = str(m.channel, "crm");
  const handle = str(m.handle);
  // A phone the AI learned, the WhatsApp number itself, or a phone the client wrote in a message.
  const turns0 = Array.isArray(m.history) ? (m.history as Record<string, unknown>[]) : [];
  const written = turns0.filter((t) => t.from === "client").map((t) => phoneInText(str(t.text))).find(Boolean) ?? null;
  const phone = normPhone(m.phone) ?? phoneOfHandle(channel, handle) ?? written;
  await c.query(
    `INSERT INTO ai_clients (id, phone, name, channel, handle, lang, first_seen, last_seen, messages, bookings, cancels, complaints, thanks, mood, intents, dialog, extra, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, now())
     ON CONFLICT (id) DO UPDATE SET phone = coalesce(EXCLUDED.phone, ai_clients.phone), name = EXCLUDED.name,
       channel = EXCLUDED.channel, handle = EXCLUDED.handle, lang = EXCLUDED.lang, first_seen = EXCLUDED.first_seen, last_seen = EXCLUDED.last_seen,
       messages = EXCLUDED.messages, bookings = EXCLUDED.bookings, cancels = EXCLUDED.cancels, complaints = EXCLUDED.complaints,
       thanks = EXCLUDED.thanks, mood = EXCLUDED.mood, intents = EXCLUDED.intents, dialog = EXCLUDED.dialog, extra = EXCLUDED.extra, updated_at = now()`,
    [
      m.id,
      phone,
      str(m.name, m.id).slice(0, 80) || m.id,
      channel,
      handle,
      str(m.lang, "ru"),
      first,
      last < first ? first : last,
      num(m.messages),
      num(m.bookings),
      num(m.cancels),
      num(m.complaints),
      num(m.thanks),
      Math.max(-1, Math.min(1, num(m.mood))),
      obj(m.intents),
      m.dialog && typeof m.dialog === "object" ? m.dialog : { stage: "idle" },
      rest(m, CLIENT),
    ],
  );

  // Learned preferences: replace with what the AI counts now. Stated and staff
  // preferences stay; only their weight follows the AI's count.
  const want: [string, string, number][] = [];
  for (const [v, w] of Object.entries(obj(m.services))) if (num(w) > 0) want.push(["service", v, num(w)]);
  for (const [v, w] of Object.entries(obj(m.staff))) if (num(w) > 0) want.push(["staff", v, num(w)]);
  for (const [v, w] of Object.entries(obj(m.times))) if (num(w) > 0) want.push(["time", v, num(w)]);
  const cur = (await c.query<{ kind: string; value: string; weight: number; source: string }>(
    `SELECT kind, value, weight, source FROM ai_client_preferences WHERE client_id = $1 AND kind IN ('service', 'staff', 'time')`,
    [m.id],
  )).rows;
  const key = (k: string, v: string) => `${k}\u0000${v}`;
  const wantMap = new Map(want.map(([k, v, w]) => [key(k, v), w]));
  for (const p of cur) if (p.source === "learned" && !wantMap.has(key(p.kind, p.value))) {
    await c.query(`DELETE FROM ai_client_preferences WHERE client_id = $1 AND kind = $2 AND value = $3`, [m.id, p.kind, p.value]);
  }
  const have = new Map(cur.map((p) => [key(p.kind, p.value), p.weight]));
  for (const [k, v, w] of want) {
    if (have.get(key(k, v)) === w) continue;
    await c.query(
      `INSERT INTO ai_client_preferences (client_id, kind, value, weight) VALUES ($1, $2, $3, $4)
       ON CONFLICT (client_id, kind, value) DO UPDATE SET weight = EXCLUDED.weight, updated_at = now()`,
      [m.id, k, v.slice(0, 200), w],
    );
  }

  // History: every message once, however many times the AI sends it.
  const turns = Array.isArray(m.history) ? (m.history as Record<string, unknown>[]) : [];
  for (const t of turns) {
    const text = str(t.text).slice(0, 4000);
    if (!text) continue;
    const sender = t.from === "client" || t.from === "ai" ? t.from : "staff";
    await c.query(
      `INSERT INTO ai_messages (client_id, sender, text, labels, sent_at) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
      [m.id, sender, text, Array.isArray(t.labels) ? t.labels.map(String) : null, date(t.at)],
    );
  }

  // One person, many messengers: link this account to the person's CRM card.
  await resolvePerson(c, m.id);
}

const clients: Mapping = {
  all: ({ c }) => readClients(c, "", []),
  async get({ c }, id) {
    return (await readClients(c, "WHERE id = $1", [id]))[0] ?? null;
  },
  async lock(ctx, id) {
    await ctx.c.query(`SELECT 1 FROM ai_clients WHERE id = $1 FOR UPDATE`, [id]);
  },
  put: ({ c }, row) => writeClient(c, row),
  async remove({ c }, id) {
    await c.query(`DELETE FROM ai_clients WHERE id = $1`, [id]);
  },
};

// ------------------------------------------------------------------ bookings
// ai_bookings (synced into CRM appointments) + CRM visits the AI did not make.

const BOOKING = ["id", "client", "clientName", "service", "staff", "start", "minutes", "price", "status", "source", "at", "crmAppointmentId", "crmStatus", "syncStatus", "syncError", "origin", "crmClientId"] as const;
// crm_client: the person (CRM card) the visit is for, whichever messenger booked it.
const CAL = `SELECT cal.*, to_char(cal.start_at, 'YYYY-MM-DD"T"HH24:MI') AS start, b.extra, b.sync_status, b.sync_error,
                    coalesce(ap.client_id, acl.crm_client_id) AS crm_client
               FROM ai_calendar cal
               LEFT JOIN ai_bookings b ON cal.origin = 'ai' AND b.id = cal.id
               LEFT JOIN appointments ap ON ap.appointment_id = cal.crm_appointment_id
               LEFT JOIN ai_clients acl ON acl.id = cal.client_id`;
const bookingRow = (r: Record<string, any>): Row => ({
  ...(r.extra ?? {}),
  id: r.id,
  client: r.client_id,
  clientName: r.client_name,
  service: r.service.trim(),
  staff: r.staff,
  start: r.start,
  minutes: r.minutes,
  price: r.price,
  status: r.status,
  source: r.source,
  at: ms(r.created_at),
  ...(r.crm_appointment_id ? { crmAppointmentId: r.crm_appointment_id, crmStatus: r.crm_status } : {}),
  ...(r.crm_client ? { crmClientId: r.crm_client } : {}),
  ...(r.origin === "ai" ? { syncStatus: r.sync_status, ...(r.sync_error ? { syncError: r.sync_error } : {}) } : { origin: "crm" }),
});
const isCrmVisit = (id: string) => /^AP-\d+$/.test(id);
const START_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

const bookings: Mapping = {
  async all({ c, config }) {
    const rows = (
      await c.query(`${CAL} WHERE cal.origin = 'ai' OR cal.start_at >= LOCALTIMESTAMP - $1::int * INTERVAL '1 day' ORDER BY cal.start_at, cal.id`, [config.crmDaysBack])
    ).rows;
    return rows.map(bookingRow);
  },
  async get(ctx, id) {
    // A CRM visit linked to an AI booking is that AI booking.
    const r = await one(ctx, `${CAL} WHERE cal.id = $1 OR (cal.origin = 'ai' AND cal.crm_appointment_id = $1) ORDER BY cal.origin LIMIT 1`, id);
    return r && bookingRow(r);
  },
  async lock(ctx, id) {
    await ctx.c.query(`SELECT 1 FROM ai_bookings WHERE id = $1 FOR UPDATE`, [id]);
  },
  async put({ c, config }, b) {
    const start = str(b.start);
    if (!START_RE.test(start)) throw badRequest(`start must look like 2026-11-06T18:00, not ${start}`);
    const status = b.status === "cancelled" ? "cancelled" : "booked";
    const minutes = Math.round(num(b.minutes));
    const isAi = (await c.query(`SELECT 1 FROM ai_bookings WHERE id = $1`, [b.id])).rowCount;
    if (!isAi && isCrmVisit(b.id)) {
      if (!(await updateCrmVisit(c, b.id, { start, minutes, status }))) throw notFound(`CRM visit ${b.id} not found`);
      return;
    }
    const source = str(b.source, "crm");
    // A booking needs its client: a booking can arrive before the client's card.
    await c.query(
      `INSERT INTO ai_clients (id, name, channel, handle, crm_client_id)
       VALUES ($1::varchar, $2, $3, '', (SELECT client_id FROM clients WHERE client_id = $1::varchar))
       ON CONFLICT (id) DO NOTHING`,
      [str(b.client), str(b.clientName, str(b.client)).slice(0, 80) || str(b.client), source],
    );
    await c.query(
      `INSERT INTO ai_bookings (id, client_id, client_name, service, staff, start_at, minutes, price, status, source, created_at, extra)
       VALUES ($1, $2, $3, $4, $5, $6::timestamp, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (id) DO UPDATE SET client_id = EXCLUDED.client_id, client_name = EXCLUDED.client_name, service = EXCLUDED.service,
         staff = EXCLUDED.staff, start_at = EXCLUDED.start_at, minutes = EXCLUDED.minutes, price = EXCLUDED.price, status = EXCLUDED.status,
         source = EXCLUDED.source, created_at = EXCLUDED.created_at, extra = EXCLUDED.extra`,
      [b.id, str(b.client), str(b.clientName).slice(0, 80), str(b.service), str(b.staff), start, minutes, num(b.price), status, source, date(b.at), rest(b, BOOKING)],
    );
    await syncBooking(c, { id: b.id, client: str(b.client), service: str(b.service), staff: str(b.staff), start, minutes, status, source }, config.crmSync);
  },
  /** Forgets the AI's copy only: a CRM visit is never deleted by the AI (cancel it instead). */
  async remove({ c }, id) {
    await c.query(`DELETE FROM ai_bookings WHERE id = $1`, [id]);
  },
};

// ------------------------------------------------------------------ versions

const VERSION = ["id", "n", "at", "phrases", "metrics", "status"] as const;
const versionRow = (r: Record<string, any>): Row => ({ ...r.extra, id: r.id, n: r.n, at: ms(r.created_at), phrases: r.trained_on, metrics: r.metrics, status: r.status });

const versions: Mapping = {
  async all({ c }) {
    return (await c.query(`SELECT * FROM ai_model_versions ORDER BY n`)).rows.map(versionRow);
  },
  async get(ctx, id) {
    const r = await one(ctx, `SELECT * FROM ai_model_versions WHERE id = $1`, id);
    return r && versionRow(r);
  },
  async lock(ctx, id) {
    await ctx.c.query(`SELECT 1 FROM ai_model_versions WHERE id = $1 FOR UPDATE`, [id]);
  },
  async put({ c }, v) {
    await c.query(
      `INSERT INTO ai_model_versions (id, n, status, trained_on, metrics, created_at, extra) VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (id) DO UPDATE SET n = EXCLUDED.n, status = EXCLUDED.status, trained_on = EXCLUDED.trained_on, metrics = EXCLUDED.metrics,
         created_at = EXCLUDED.created_at, extra = EXCLUDED.extra`,
      [v.id, num(v.n), str(v.status), num(v.phrases), obj(v.metrics), date(v.at), rest(v, VERSION)],
    );
  },
  async remove({ c }, id) {
    await c.query(`DELETE FROM ai_model_versions WHERE id = $1`, [id]);
  },
};

// ------------------------------------------------------------------ events

const EVENT = ["id", "at", "kind", "title", "detail"] as const;
const eventRow = (r: Record<string, any>): Row => clean({ id: r.id, at: ms(r.created_at), kind: r.kind, title: r.title, detail: r.detail }, ["detail"]);

const events: Mapping = {
  async all({ c }) {
    return (await c.query(`SELECT * FROM ai_events ORDER BY created_at, id`)).rows.map(eventRow);
  },
  async get(ctx, id) {
    const r = await one(ctx, `SELECT * FROM ai_events WHERE id = $1`, id);
    return r && eventRow(r);
  },
  async put({ c }, e) {
    const extra = rest(e, EVENT);
    const detail = e.detail === undefined && !Object.keys(extra).length ? null : { ...obj(e.detail), ...extra };
    await c.query(
      `INSERT INTO ai_events (id, kind, title, detail, created_at) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (id) DO UPDATE SET kind = EXCLUDED.kind, title = EXCLUDED.title, detail = EXCLUDED.detail, created_at = EXCLUDED.created_at`,
      [e.id, str(e.kind), str(e.title), detail, date(e.at)],
    );
  },
  async remove({ c }, id) {
    await c.query(`DELETE FROM ai_events WHERE id = $1`, [id]);
  },
};

// ------------------------------------------------------------------ settings
// "business" is built from the CRM until the AI saves its own copy.

const settings: Mapping = {
  async all(ctx) {
    const rows = (await ctx.c.query(`SELECT id, value FROM ai_settings ORDER BY id`)).rows.map((r) => ({ ...r.value, id: r.id }) as Row);
    if (!rows.some((r) => r.id === "business")) rows.unshift({ ...(await businessFromCrm(ctx.c, ctx.tenant)), id: "business" });
    return rows;
  },
  async get(ctx, id) {
    const r = await one(ctx, `SELECT id, value FROM ai_settings WHERE id = $1`, id);
    if (r) return { ...r.value, id: r.id };
    if (id === "business") return { ...(await businessFromCrm(ctx.c, ctx.tenant)), id: "business" };
    return null;
  },
  async lock(ctx, id) {
    await ctx.c.query(`SELECT 1 FROM ai_settings WHERE id = $1 FOR UPDATE`, [id]);
  },
  async put({ c }, s) {
    const { id, ...value } = s;
    await c.query(`INSERT INTO ai_settings (id, value) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [id, value]);
  },
  async remove({ c }, id) {
    await c.query(`DELETE FROM ai_settings WHERE id = $1`, [id]);
  },
};

export const MAPPINGS: Record<Collection, Mapping> = { phrases, queue, knowledge, clients, bookings, versions, events, settings };

// ------------------------------------------------------------------ the five Store methods

// Ids may hold letters of any language (the AI makes "telegram-айгерим"),
// but no spaces or characters that break a URL.
const ID_RE = /^[^\s/\\?#%]{1,64}$/u;
function checkId(id: unknown): asserts id is string {
  if (typeof id !== "string" || !ID_RE.test(id)) throw badRequest("id must be 1 to 64 characters without spaces or / \\ ? # %");
}

export const storeAll = (ctx: Ctx, col: Collection) => MAPPINGS[col].all(ctx);
export const storeGet = (ctx: Ctx, col: Collection, id: string) => MAPPINGS[col].get(ctx, id);

export async function storePut(ctx: Ctx, col: Collection, row: Row): Promise<void> {
  checkId(row?.id);
  await MAPPINGS[col].put(ctx, row);
}

export async function storePatch(ctx: Ctx, col: Collection, id: string, data: Record<string, unknown>): Promise<Row> {
  checkId(id);
  const m = MAPPINGS[col];
  await m.lock?.(ctx, id);
  const cur = await m.get(ctx, id);
  if (!cur) throw notFound(`${col}/${id} does not exist`);
  const { id: _ignored, ...change } = data;
  const next = deepMerge(cur, change) as Row;
  next.id = id;
  await m.put(ctx, next);
  return next;
}

export async function storeRemove(ctx: Ctx, col: Collection, id: string): Promise<void> {
  checkId(id);
  await MAPPINGS[col].remove(ctx, id);
}

/** Rebuilds settings/business from the CRM, keeping the AI's names and stems. */
export async function syncBusiness(ctx: Ctx): Promise<AiBusiness> {
  const cur = (await settings.get(ctx, "business")) as unknown as Partial<AiBusiness> | null;
  const { id: _id, ...keep } = (cur ?? {}) as Record<string, unknown>;
  const biz = await businessFromCrm(ctx.c, ctx.tenant, keep as Partial<AiBusiness>);
  await settings.put(ctx, { ...biz, id: "business" });
  return biz;
}
