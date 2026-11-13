import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startEnv, type TestEnv } from "./helpers.js";

let env: TestEnv;
beforeAll(async () => {
  env = await startEnv();
});
afterAll(() => env.close());

describe("analytics", () => {
  it("adds up the CRM's demo data", async () => {
    const res = await env.api("/v1/analytics");
    expect(res.status).toBe(200);
    const d = res.body;
    expect(d.business).toBe("Barberista");
    expect(d.services.length).toBe(8);
    // Revenue = completed visits at the price list price, the same as SQL straight on the CRM tables.
    const direct = (await env.sql(`SELECT sum(s.price_kzt)::int AS r FROM appointments a JOIN services s USING (service_code) WHERE a.status = 'Completed'`))[0].r;
    expect(d.services.reduce((s: number, r: { revenue: number }) => s + r.revenue, 0)).toBe(direct);
    expect(d.channels.map((r: { channel: string }) => r.channel).sort()).toEqual(["Admin", "Instagram", "Telegram", "WhatsApp"]);
    expect(d.weekdays.every((r: { weekday: number }) => r.weekday >= 1 && r.weekday <= 7)).toBe(true);
    expect(d.masters.length).toBe(4);
    expect(d.funnel.length).toBeGreaterThan(0);
    expect(Array.isArray(d.aiQuality)).toBe(true);
  });

  it("needs a key, and another business sees only its own numbers", async () => {
    expect((await env.api("/v1/analytics", { key: "" })).status).toBe(401);
    const b = (await env.api("/v1/analytics", { key: env.keyB })).body;
    expect(b.business).toBe("Empty Studio");
    expect(b.channels).toEqual([]);
  });

  it("serves the dashboard page", async () => {
    const res = await env.api("/dashboard", { key: "" });
    expect(res.status).toBe(200);
    expect(res.text).toContain("VoroniX Analytics");
  });
});
