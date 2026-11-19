// CRM_SYNC decides which CRM refusals cancel an AI booking. "loose" is covered
// in store.test.ts; these tests pin down "strict" and "off".
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startEnv, type TestEnv } from "./helpers.js";
import type { ServerStore } from "../client/server-store.js";

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
  at: Date.UTC(2026, 10, 5, 12, 0, 0),
  ...over,
});

describe("CRM_SYNC=strict", () => {
  let env: TestEnv;
  let store: ServerStore;
  beforeAll(async () => {
    env = await startEnv({ CRM_SYNC: "strict" });
    store = env.store();
  });
  afterAll(() => env.close());

  it("a booking the CRM can take becomes a CRM visit", async () => {
    await store.put("bookings", booking());
    const b = (await store.all("bookings")).find((x) => x.id === "bk-1")!;
    expect(b).toMatchObject({ syncStatus: "synced", crmStatus: "Booked" });
  });

  it("refuses a booking the CRM cannot take (unknown service) and does not keep it", async () => {
    const err = await store.put("bookings", booking({ id: "bk-2", service: "XX-99", start: "2027-03-03T12:00" })).catch((e) => e);
    expect(err).toMatchObject({ status: 409 });
    expect((await store.all("bookings")).find((x) => x.id === "bk-2")).toBeUndefined();
  });

  it("still refuses a busy slot", async () => {
    const err = await store.put("bookings", booking({ id: "bk-3", start: "2027-03-02T12:30" })).catch((e) => e);
    expect(err).toMatchObject({ status: 409 });
  });
});

describe("CRM_SYNC=off", () => {
  let env: TestEnv;
  let store: ServerStore;
  beforeAll(async () => {
    env = await startEnv({ CRM_SYNC: "off" });
    store = env.store();
  });
  afterAll(() => env.close());

  it("keeps the booking for the AI and never creates a CRM visit", async () => {
    const before = (await env.sql(`SELECT count(*)::int AS n FROM appointments`))[0].n;
    await store.put("bookings", booking({ service: "XX-99" }));
    const b = (await store.all("bookings")).find((x) => x.id === "bk-1")!;
    expect(b).toBeDefined();
    expect(b.crmStatus ?? null).toBeNull();
    expect((await env.sql(`SELECT count(*)::int AS n FROM appointments`))[0].n).toBe(before);
  });
});
