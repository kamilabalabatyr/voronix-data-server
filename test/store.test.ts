import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startEnv, type TestEnv } from "./helpers.js";
import type { ServerStore } from "../client/server-store.js";

let env: TestEnv;
let store: ServerStore;
const T = Date.UTC(2026, 10, 5, 12, 0, 0);

beforeAll(async () => {
  env = await startEnv();
  store = env.store();
});
afterAll(() => env.close());

const aliya = () => ({
  id: "ig-aliya",
  name: "Алия",
  channel: "instagram",
  handle: "@aliya.k",
  lang: "ru",
  first: T,
  last: T + 60_000,
  messages: 2,
  intents: { booking: 1, thanks: 1 },
  services: { "HC-01": 2 },
  staff: { "MS-02": 2 },
  times: { morning: 0, day: 0, evening: 2 },
  bookings: 2,
  cancels: 0,
  complaints: 0,
  thanks: 1,
  mood: 0.3,
  history: [
    { at: T, from: "client", text: "Хочу записаться на стрижку", labels: ["booking"] },
    { at: T + 1000, from: "ai", text: "Есть время сегодня в 18:00 у Армана" },
  ],
  dialog: { stage: "idle" },
});

describe("the AI's objects come back exactly as they were saved", () => {
  it("phrases, queue, versions, events, settings", async () => {
    const phrase = { id: "p-1", text: "Сколько стоит стрижка?", lang: "ru", labels: ["price"], source: "client", why: "booking confirmed it", at: T, client: "ig-aliya" };
    const item = { id: "q-1", kind: "unsure", text: "а можно с собакой?", lang: "ru", guess: ["other"], score: 0.41, client: "ig-aliya", clientName: "Алия", channel: "instagram", truth: ["other"], at: T };
    const version = { id: "v-1", n: 1, at: T, upto: T, phrases: 120, metrics: { exact: 0.9, f1: 0.93, lang: 0.99 }, prev: null, status: "live", trigger: "start", ms: 840, holdout: 24 };
    const event = { id: "ev-1", at: T, kind: "learn", title: "Learned «Сколько стоит стрижка?» → price", detail: { steps: 3 } };
    const prefs = { id: "prefs", retrainEvery: 25 };
    await store.put("phrases", phrase);
    await store.put("queue", item);
    await store.put("versions", version);
    await store.put("events", event);
    await store.put("settings", prefs);
    expect(await store.all("phrases")).toEqual([phrase]);
    expect(await store.all("queue")).toEqual([item]);
    expect(await store.all("versions")).toEqual([version]);
    expect(await store.all("events")).toEqual([event]);
    expect((await store.all("settings")).find((r) => r.id === "prefs")).toEqual(prefs);
  });

  it("a client memory card, with fields the AI may add later", async () => {
    const m = { ...aliya(), vip: true };
    await store.put("clients", m);
    const back = (await store.all("clients")).find((c) => c.id === "ig-aliya");
    expect(back).toEqual(m);
  });

  it("patch merges like the site database and keeps one live model", async () => {
    await store.patch("versions", "v-1", { status: "old", metrics: { f1: 0.95 } });
    const v = (await store.all("versions"))[0];
    expect(v.status).toBe("old");
    expect(v.metrics).toEqual({ exact: 0.9, f1: 0.95, lang: 0.99 });
    await store.put("versions", { ...v, id: "v-2", n: 2, status: "live" });
    await expect(store.put("versions", { ...v, id: "v-3", n: 3, status: "live" })).rejects.toMatchObject({ status: 409 });
  });

  it("refuses data that breaks the rules", async () => {
    await expect(store.put("phrases", { id: "p-bad", text: "Hallo", lang: "de", labels: ["greeting"], source: "client", why: "", at: T })).rejects.toMatchObject({ status: 400 });
    await expect(store.put("phrases", { id: "p-bad", text: "Hi", lang: "en", labels: ["dance"], source: "client", why: "", at: T })).rejects.toMatchObject({ status: 400 });
    await expect(store.put("clients", { ...aliya(), id: "bad id!" })).rejects.toMatchObject({ status: 400 });
    // The AI makes ids from names in any language.
    await store.put("clients", { ...aliya(), id: "telegram-айгерим", history: [] });
    expect((await store.all("clients")).some((c) => c.id === "telegram-айгерим")).toBe(true);
    await store.remove("clients", "telegram-айгерим");
    await expect(store.patch("phrases", "nope", { text: "x" })).rejects.toMatchObject({ status: 404 });
  });
});

describe("client preferences and history", () => {
  it("are stored in their own tables, and a staff note survives the AI's next save", async () => {
    const add = await env.api("/v1/clients/ig-aliya/preferences", { method: "POST", body: JSON.stringify({ kind: "note", value: "Любит короче на висках", source: "stated" }) });
    expect(add.status).toBe(201);
    await env.api("/v1/clients/ig-aliya/preferences", { method: "POST", body: JSON.stringify({ kind: "staff", value: "MS-01", source: "staff" }) });

    // The AI saves the card again: it counted one more evening haircut.
    const m = aliya();
    await store.put("clients", { ...m, services: { "HC-01": 3 }, times: { morning: 0, day: 0, evening: 3 }, history: [...m.history, { at: T + 2000, from: "client", text: "Спасибо!", labels: ["thanks"] }] });

    const prefs = await env.sql(`SELECT kind, value, weight, source FROM ai_client_preferences WHERE client_id = 'ig-aliya' ORDER BY kind, value`);
    expect(prefs).toEqual([
      { kind: "note", value: "Любит короче на висках", weight: 1, source: "stated" },
      { kind: "service", value: "HC-01", weight: 3, source: "learned" },
      { kind: "staff", value: "MS-01", weight: 1, source: "staff" },
      { kind: "staff", value: "MS-02", weight: 2, source: "learned" },
      { kind: "time", value: "evening", weight: 3, source: "learned" },
    ]);
    const back = (await store.all("clients")).find((c) => c.id === "ig-aliya")!;
    expect(back.notes).toEqual(["Любит короче на висках"]);
    expect(back.staff).toEqual({ "MS-01": 1, "MS-02": 2 });

    // A learned preference the AI no longer counts is removed; the staff one stays.
    await store.put("clients", { ...m, staff: {}, history: [] });
    const staff = await env.sql(`SELECT value, source FROM ai_client_preferences WHERE client_id = 'ig-aliya' AND kind = 'staff'`);
    expect(staff).toEqual([{ value: "MS-01", source: "staff" }]);
    // Every message once, even though the AI sent the first two twice.
    expect((await env.sql(`SELECT count(*)::int AS n FROM ai_messages WHERE client_id = 'ig-aliya'`))[0].n).toBe(3);

    const card = await env.api("/v1/clients/ig-aliya/card");
    expect(card.body.card).toMatchObject({ usual_service: "HC-01", usual_staff: "MS-01", usual_time: "evening", notes: "Любит короче на висках" });
  });

  it("keeps the whole history while the AI sees the last 14 messages", async () => {
    const m = aliya();
    const history = Array.from({ length: 30 }, (_, i) => ({ at: T + 10_000 + i * 1000, from: i % 2 ? "ai" : "client", text: `сообщение ${i}` }));
    await store.put("clients", { ...m, history });
    const back = (await store.all("clients")).find((c) => c.id === "ig-aliya")!;
    expect((back.history as unknown[]).length).toBe(14);
    expect((back.history as { text: string }[]).at(-1)!.text).toBe("сообщение 29");
    const all = await env.api("/v1/clients/ig-aliya/messages?limit=1000");
    expect(all.body.messages.length).toBe(33);
  });

  it("finds the CRM card of a client who writes from a known messenger account", async () => {
    // CRM demo: CL-0001 Арман Т. writes from WhatsApp wh_5000.
    await store.put("clients", { ...aliya(), id: "wa-arman", name: "Арман", channel: "whatsapp", handle: "wh_5000", history: [] });
    const back = (await store.all("clients")).find((c) => c.id === "wa-arman")!;
    expect(back.crmClientId).toBe("CL-0001");
    const card = await env.api("/v1/clients/wa-arman/card");
    expect(card.body.crm.client.id).toBe("CL-0001");
    expect(card.body.bookings.length).toBeGreaterThan(0);
  });
});

describe("bookings become CRM appointments", () => {
  const booking = (over: Record<string, unknown> = {}) => ({
    id: "bk-1",
    client: "tg-dana",
    clientName: "Дана",
    service: "HC-01",
    staff: "MS-02",
    start: "2027-03-02T12:00",
    minutes: 60,
    price: 7000,
    status: "booked",
    source: "telegram",
    at: T,
    ...over,
  });

  it("a booking for a new client creates the CRM client, its Telegram account and the visit", async () => {
    await store.put("clients", { ...aliya(), id: "tg-dana", name: "Дана", channel: "telegram", handle: "dana_tg", history: [] });
    await store.put("bookings", booking());
    const b = (await store.all("bookings")).find((x) => x.id === "bk-1")!;
    expect(b).toMatchObject({ syncStatus: "synced", crmStatus: "Booked", start: "2027-03-02T12:00" });
    const ap = (await env.sql(`SELECT a.*, c.display_name, to_char(a.end_at, 'HH24:MI') AS ends FROM appointments a JOIN clients c USING (client_id) WHERE appointment_id = $1`, [b.crmAppointmentId]))[0];
    expect(ap).toMatchObject({ display_name: "Дана", master_id: "MS-02", service_code: "HC-01", status: "Booked", source: "Telegram", ends: "13:00" });
    const ch = await env.sql(`SELECT messenger, external_user_id FROM client_channels WHERE client_id = $1`, [ap.client_id]);
    expect(ch).toEqual([{ messenger: "Telegram", external_user_id: "dana_tg" }]);
  });

  it("refuses a slot the staff already booked in the CRM", async () => {
    const busy = (
      await env.sql(`SELECT master_id, service_code, to_char(start_at, 'YYYY-MM-DD"T"HH24:MI') AS start FROM appointments
                      WHERE status NOT IN ('Cancelled') AND start_at > LOCALTIMESTAMP ORDER BY start_at LIMIT 1`)
    )[0];
    expect(busy).toBeTruthy();
    const err = await store.put("bookings", booking({ id: "bk-busy", staff: busy.master_id, service: busy.service_code.trim(), start: busy.start })).catch((e) => e);
    expect(err).toMatchObject({ status: 409, code: "slot_taken" });
    expect(await env.sql(`SELECT 1 FROM ai_bookings WHERE id = 'bk-busy'`)).toEqual([]);
  });

  it("refuses two AI bookings at the same time with the same master", async () => {
    const err = await store.put("bookings", booking({ id: "bk-2", start: "2027-03-02T12:30" })).catch((e) => e);
    expect(err).toMatchObject({ status: 409 });
  });

  it("cancelling in the AI cancels the CRM visit", async () => {
    await store.patch("bookings", "bk-1", { status: "cancelled" });
    const b = (await store.all("bookings")).find((x) => x.id === "bk-1")!;
    expect(b).toMatchObject({ status: "cancelled", crmStatus: "Cancelled" });
  });

  it("keeps a booking the CRM cannot take (unknown service) and says why", async () => {
    await store.put("bookings", booking({ id: "bk-3", service: "XX-99", start: "2027-03-03T12:00" }));
    const b = (await store.all("bookings")).find((x) => x.id === "bk-3")!;
    expect(b.syncStatus).toBe("skipped");
    expect(b.syncError).toMatch(/XX-99/);
  });

  it("shows CRM visits to the AI and lets it cancel one", async () => {
    const all = await store.all("bookings");
    const crm = all.filter((b) => b.origin === "crm");
    expect(crm.length).toBeGreaterThan(5);
    const future = (await env.sql(`SELECT appointment_id FROM appointments WHERE status = 'Booked' AND start_at > LOCALTIMESTAMP AND appointment_id NOT IN (SELECT crm_appointment_id FROM ai_bookings WHERE crm_appointment_id IS NOT NULL) LIMIT 1`))[0];
    await store.patch("bookings", future.appointment_id, { status: "cancelled" });
    expect((await env.sql(`SELECT status FROM appointments WHERE appointment_id = $1`, [future.appointment_id]))[0].status).toBe("Cancelled");
  });

  it("a booking that arrives before its client still has a client", async () => {
    await store.put("bookings", booking({ id: "bk-4", client: "ig-new", clientName: "Новый", source: "instagram", start: "2027-03-04T12:00" }));
    expect((await env.sql(`SELECT name, channel FROM ai_clients WHERE id = 'ig-new'`))[0]).toEqual({ name: "Новый", channel: "instagram" });
  });

  it("removing the AI's copy never deletes the CRM visit", async () => {
    const b = (await store.all("bookings")).find((x) => x.id === "bk-4")!;
    await store.remove("bookings", "bk-4");
    expect((await env.sql(`SELECT status FROM appointments WHERE appointment_id = $1`, [b.crmAppointmentId]))[0].status).toBe("Booked");
  });
});

describe("business data the AI learns from", () => {
  it("settings/business is built from the CRM services and masters", async () => {
    const biz = (await store.all("settings")).find((r) => r.id === "business") as any;
    expect(biz.name).toBe("Barberista");
    expect(biz.currency).toBe("₸");
    expect(biz.services.find((s: any) => s.id === "VP-07")).toMatchObject({ minutes: 150, price: 22000, names: { ru: "VIP-ритуал" } });
    expect(biz.staff.find((m: any) => m.id === "MS-04")).toMatchObject({ name: "Ержан М.", from: "10:00", to: "19:00", days: [1, 2, 3, 4, 5] });
  });

  it("sync keeps the names and stems the AI already has", async () => {
    const biz = (await store.all("settings")).find((r) => r.id === "business") as any;
    const hc = biz.services.find((s: any) => s.id === "HC-01");
    hc.names = { ru: "Мужская стрижка", kk: "Ерлер шаш қию", en: "Men's haircut" };
    hc.stems = ["стриж", "haircut"];
    await store.put("settings", biz);
    await env.sql(`UPDATE services SET price_kzt = 7500 WHERE service_code = 'HC-01'`);
    const synced = (await env.api("/v1/crm/business/sync", { method: "POST" })).body.business;
    expect(synced.services.find((s: any) => s.id === "HC-01")).toMatchObject({ id: "HC-01", price: 7500, names: { kk: "Ерлер шаш қию" }, stems: ["стриж", "haircut"] });
  });

  it("CRM knowledge entries are part of the AI's knowledge but stay owned by the CRM", async () => {
    const k = await store.all("knowledge");
    expect(k.filter((x) => x.origin === "crm").length).toBe(6);
    await expect(store.remove("knowledge", k[0].id)).rejects.toMatchObject({ status: 409 });
  });

  it("a document is kept whole, cut into entries and found by search", async () => {
    const content = [
      "Акции ноября",
      "Каждый вторник скидка 20% на детскую стрижку. Скидка не суммируется с другими акциями.",
      "",
      "Подарочные сертификаты",
      "Сертификат на любую сумму от 5 000 ₸ можно купить на ресепшене или через Kaspi.",
      "",
      "Парковка",
      "Бесплатная парковка во дворе, въезд с улицы Жибек жолы.",
    ].join("\n");
    const res = await env.api("/v1/knowledge/documents", { method: "POST", body: JSON.stringify({ title: "Правила салона", content, fileName: "rules.txt" }) });
    expect(res.status).toBe(201);
    const hits = (await env.api(`/v1/knowledge/search?q=${encodeURIComponent("скидка по вторникам")}`)).body.hits;
    expect(hits[0].text).toMatch(/скидка 20%/);
    expect(hits[0].snippet).toMatch(/«/);
    const park = (await env.api(`/v1/knowledge/search?q=${encodeURIComponent("у вас есть парковка?")}`)).body.hits;
    expect(park[0].text).toMatch(/парковка/i);
    expect((await store.all("knowledge")).some((k) => k.documentId === res.body.documentId)).toBe(true);
    // Deleting the document deletes its entries.
    await env.api(`/v1/knowledge/documents/${res.body.documentId}`, { method: "DELETE" });
    expect((await store.all("knowledge")).some((k) => k.documentId === res.body.documentId)).toBe(false);
  });

  it("exports training phrases in the AI's phrases.tsv format", async () => {
    await store.put("phrases", { id: "p-2", text: "Сәлеметсіз бе\tқалайсыз", lang: "kk", labels: ["greeting"], source: "operator", why: "checked", at: T + 5 });
    const tsv = await env.api("/v1/training/phrases.tsv");
    const lines = tsv.text.trim().split("\n");
    expect(lines[1]).toBe("lang\tlabels\ttext");
    expect(lines).toContain("kk\tgreeting\tСәлеметсіз бе қалайсыз");
  });
});

describe("access", () => {
  it("needs a key, and a key opens only its own business", async () => {
    expect((await env.api("/v1/store/clients", { key: "" })).status).toBe(401);
    expect((await env.api("/v1/store/clients", { key: "vxd_aaaaaaaaaaaa_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" })).status).toBe(401);
    const other = env.store(env.keyB);
    expect(await other.all("clients")).toEqual([]);
    expect(await other.all("bookings")).toEqual([]);
    await other.put("clients", { ...aliya(), history: [] });
    expect((await env.sql(`SELECT count(*)::int AS n FROM ai_clients WHERE id = 'ig-aliya'`))[0].n).toBe(1);
    const stats = (await env.api("/v1/stats", { key: env.keyB })).body;
    expect(stats.counts.ai_clients).toBe(1);
  });
});
