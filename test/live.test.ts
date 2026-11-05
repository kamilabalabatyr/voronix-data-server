import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startEnv, until, type TestEnv } from "./helpers.js";
import type { Change, Row } from "../client/store.js";

let env: TestEnv;
beforeAll(async () => {
  env = await startEnv();
});
afterAll(() => env.close());

describe("live changes", () => {
  it("a page watching sees what another page saves, like the site database", async () => {
    const a = env.store();
    const b = env.store();
    let rows: Row[] = [];
    const seen: Change[] = [];
    let first = false;
    const stop = a.watch("phrases", (r, ch) => {
      rows = r;
      if (first) seen.push(...ch);
      first = true;
    });
    await until(() => first);
    await new Promise((r) => setTimeout(r, 100));
    await b.put("phrases", { id: "p-live", text: "Привет", lang: "ru", labels: ["greeting"], source: "client", why: "", at: Date.now() });
    await until(() => rows.some((r) => r.id === "p-live"));
    expect(seen[0]).toMatchObject({ type: "added", row: { id: "p-live" } });
    await b.remove("phrases", "p-live");
    await until(() => !rows.some((r) => r.id === "p-live"));
    expect(seen.at(-1)).toMatchObject({ type: "removed", row: { id: "p-live" } });
    stop();
  });

  it("a visit the staff cancel in the CRM reaches the AI at once", async () => {
    const s = env.store();
    let rows: Row[] = [];
    s.watch("bookings", (r) => (rows = r));
    await until(() => rows.length > 0);
    const ap = (await env.sql(`SELECT appointment_id FROM appointments WHERE status = 'Booked' AND start_at > LOCALTIMESTAMP LIMIT 1`))[0].appointment_id;
    expect(rows.find((r) => r.id === ap)?.status).toBe("booked");
    await env.sql(`UPDATE appointments SET status = 'Cancelled' WHERE appointment_id = $1`, [ap]);
    await until(() => rows.find((r) => r.id === ap)?.status === "cancelled");
  });

  it("a staff note on a client reaches the AI's memory card", async () => {
    const s = env.store();
    await s.put("clients", { id: "ig-zhan", name: "Жан", channel: "instagram", handle: "@zhan", lang: "kk", first: Date.now(), last: Date.now(), messages: 0, intents: {}, services: {}, staff: {}, times: { morning: 0, day: 0, evening: 0 }, bookings: 0, cancels: 0, complaints: 0, thanks: 0, mood: 0, history: [], dialog: { stage: "idle" } });
    let rows: Row[] = [];
    s.watch("clients", (r) => (rows = r));
    await until(() => rows.some((r) => r.id === "ig-zhan"));
    await env.api("/v1/clients/ig-zhan/preferences", { method: "POST", body: JSON.stringify({ kind: "note", value: "Сөйлескенді ұнатпайды" }) });
    await until(() => (rows.find((r) => r.id === "ig-zhan")?.notes as string[] | undefined)?.[0] === "Сөйлескенді ұнатпайды");
  });
});
