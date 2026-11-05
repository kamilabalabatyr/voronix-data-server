// One person, many messengers: a client who wrote from Instagram and later
// from WhatsApp or Telegram is one CRM client, not two.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startEnv, type TestEnv } from "./helpers.js";
import { normPhone, phoneInText } from "../src/identity.js";
import type { ServerStore } from "../client/server-store.js";

let env: TestEnv;
let store: ServerStore;
const T = Date.UTC(2026, 10, 6, 9, 0, 0);

beforeAll(async () => {
  env = await startEnv();
  store = env.store();
});
afterAll(() => env.close());

const account = (id: string, name: string, channel: string, handle: string, history: { from: string; text: string }[] = []) => ({
  id,
  name,
  channel,
  handle,
  lang: "ru",
  first: T,
  last: T + 1000,
  messages: history.filter((h) => h.from === "client").length,
  intents: {},
  services: {},
  staff: {},
  times: { morning: 0, day: 0, evening: 0 },
  bookings: 0,
  cancels: 0,
  complaints: 0,
  thanks: 0,
  mood: 0,
  history: history.map((h, i) => ({ at: T + i * 1000, ...h })),
  dialog: { stage: "idle" },
});
const get = async (id: string) => (await store.all("clients")).find((c) => c.id === id) as any;

describe("phones", () => {
  it("are read however they are typed", () => {
    expect(normPhone("+7 (701) 234-56-78")).toBe("+77012345678");
    expect(normPhone("8 701 234 56 78")).toBe("+77012345678");
    expect(normPhone("7012345678")).toBe("+77012345678");
    expect(phoneInText("Запишите, мой номер 8 701 234 56 78, спасибо")).toBe("+77012345678");
    expect(phoneInText("Сколько стоит стрижка? 7000 тенге")).toBeNull();
    expect(phoneInText("заказ 123456789012")).toBeNull();
  });
});

describe("one client, many messengers", () => {
  it("Instagram first, then WhatsApp: the phone the client wrote joins them into one CRM client", async () => {
    // 1. Aigerim writes from Instagram and leaves her phone in the chat.
    await store.put("clients", account("c-instagram-aigerim", "Айгерим", "instagram", "@aigerim.k", [{ from: "client", text: "Здравствуйте! Мой номер +7 701 555 12 34" }]));
    // 2. A week later she writes from WhatsApp: the account is that phone.
    await store.put("clients", account("c-whatsapp-aigerim", "Айгерим", "whatsapp", "77015551234", [{ from: "client", text: "Хочу записаться" }]));

    const ig = await get("c-instagram-aigerim");
    const wa = await get("c-whatsapp-aigerim");
    expect(ig.phone).toBe("+77015551234");
    expect(ig.crmClientId).toBeUndefined(); // no card until she books or matches the CRM
    expect(wa.crmClientId).toBeUndefined();

    // 3. She books from WhatsApp: ONE CRM card, with both messengers.
    await store.put("bookings", {
      id: "bk-aig",
      client: "c-whatsapp-aigerim",
      clientName: "Айгерим",
      service: "HC-01",
      staff: "MS-02",
      start: "2027-04-06T12:00",
      minutes: 60,
      price: 7000,
      status: "booked",
      source: "whatsapp",
      at: T,
    });
    const both = (await env.sql(`SELECT id, crm_client_id FROM ai_clients WHERE id LIKE 'c-%-aigerim' ORDER BY id`)).map((r) => r.crm_client_id);
    expect(both[0]).toBeTruthy();
    expect(both[0]).toBe(both[1]);
    const crm = both[0];
    expect(await env.sql(`SELECT messenger, external_user_id FROM client_channels WHERE client_id = $1 ORDER BY messenger`, [crm])).toEqual([
      { messenger: "Instagram", external_user_id: "@aigerim.k" },
      { messenger: "WhatsApp", external_user_id: "77015551234" },
    ]);
    expect((await env.sql(`SELECT phone FROM clients WHERE client_id = $1`, [crm]))[0].phone).toBe("+77015551234");

    // 4. The AI sees the person from either account.
    const person = (await get("c-instagram-aigerim")).person;
    expect(person.crmClientId).toBe(crm);
    expect(person.accounts.map((a: any) => a.channel).sort()).toEqual(["instagram", "whatsapp"]);
    expect(person.visits).toBe(1);
    // ...and the booking says whose it is, so Instagram can cancel a WhatsApp booking.
    expect((await store.all("bookings")).find((b) => b.id === "bk-aig")!.crmClientId).toBe(crm);
  });

  it("a phone already in the CRM joins the new account to that client", async () => {
    // CRM demo: CL-0001 Арман Т., phone +7 700 000 1000, writes from WhatsApp and Telegram.
    await store.put("clients", account("c-instagram-arman", "Арман", "instagram", "@arman.t", [{ from: "client", text: "Это Арман, 87000001000" }]));
    expect((await get("c-instagram-arman")).crmClientId).toBe("CL-0001");
    expect((await env.sql(`SELECT 1 FROM client_channels WHERE client_id = 'CL-0001' AND messenger = 'Instagram'`)).length).toBe(1);
  });

  it("two CRM cards of one person are joined into the older one, with all visits", async () => {
    // Two cards made separately: one from Telegram, one from Instagram.
    await store.put("clients", account("c-telegram-dana", "Дана", "telegram", "dana_tg"));
    await store.put("clients", account("c-instagram-dana", "Дана", "instagram", "@dana.b"));
    for (const [id, client, start] of [
      ["bk-d1", "c-telegram-dana", "2027-04-07T12:00"],
      ["bk-d2", "c-instagram-dana", "2027-04-08T12:00"],
    ])
      await store.put("bookings", { id, client, clientName: "Дана", service: "HC-01", staff: "MS-02", start, minutes: 60, price: 7000, status: "booked", source: client.split("-")[1], at: T });
    const before = (await env.sql(`SELECT DISTINCT crm_client_id FROM ai_clients WHERE id LIKE 'c-%-dana'`)).length;
    expect(before).toBe(2);

    // Same name, different messengers: offered to a person to check.
    const cand = (await env.api("/v1/clients/duplicates")).body.candidates;
    expect(cand.some((c: any) => [c.client_a, c.client_b].sort().join() === "c-instagram-dana,c-telegram-dana")).toBe(true);

    // The administrator confirms: one card.
    const merged = await env.api("/v1/clients/c-instagram-dana/merge", { method: "POST", body: JSON.stringify({ with: "c-telegram-dana" }) });
    expect(merged.status).toBe(200);
    const crm = merged.body.crmClientId;
    expect((await env.sql(`SELECT DISTINCT crm_client_id FROM ai_clients WHERE id LIKE 'c-%-dana'`)).map((r) => r.crm_client_id)).toEqual([crm]);
    expect((await env.sql(`SELECT count(*)::int AS n FROM appointments WHERE client_id = $1 AND status = 'Booked'`, [crm]))[0].n).toBe(2);
    expect((await env.sql(`SELECT count(*)::int AS n FROM client_channels WHERE client_id = $1`, [crm]))[0].n).toBe(2);
    // No longer a candidate.
    const after = (await env.api("/v1/clients/duplicates")).body.candidates;
    expect(after.some((c: any) => [c.client_a, c.client_b].sort().join() === "c-instagram-dana,c-telegram-dana")).toBe(false);
  });

  it("two different people with the same name stay apart once a person says so", async () => {
    await store.put("clients", account("c-telegram-aliya", "Алия", "telegram", "aliya_one"));
    await store.put("clients", account("c-whatsapp-aliya", "Алия Н.", "whatsapp", "77019998877"));
    const pair = (c: any) => [c.client_a, c.client_b].sort().join() === "c-telegram-aliya,c-whatsapp-aliya";
    expect((await env.api("/v1/clients/duplicates")).body.candidates.some(pair)).toBe(true);
    await env.api("/v1/clients/c-telegram-aliya/not-same", { method: "POST", body: JSON.stringify({ with: "c-whatsapp-aliya" }) });
    expect((await env.api("/v1/clients/duplicates")).body.candidates.some(pair)).toBe(false);
    const ids = (await env.sql(`SELECT crm_client_id FROM ai_clients WHERE id IN ('c-telegram-aliya', 'c-whatsapp-aliya')`)).map((r) => r.crm_client_id);
    expect(ids.every((x) => x === null)).toBe(true);
  });

  it("the staff can give a phone and the accounts join", async () => {
    await store.put("clients", account("c-telegram-nurlan", "Нурлан", "telegram", "nurik"));
    await store.put("clients", account("c-whatsapp-nurlan", "Нурлан", "whatsapp", "+7 705 111 22 33"));
    await store.put("bookings", { id: "bk-n", client: "c-whatsapp-nurlan", clientName: "Нурлан", service: "HC-01", staff: "MS-02", start: "2027-04-09T12:00", minutes: 60, price: 7000, status: "booked", source: "whatsapp", at: T });
    const res = await env.api("/v1/clients/c-telegram-nurlan/phone", { method: "POST", body: JSON.stringify({ phone: "8 705 111 22 33" }) });
    expect(res.status).toBe(200);
    const ids = (await env.sql(`SELECT crm_client_id FROM ai_clients WHERE id LIKE 'c-%-nurlan'`)).map((r) => r.crm_client_id);
    expect(ids[0]).toBeTruthy();
    expect(ids[0]).toBe(ids[1]);
  });
});
