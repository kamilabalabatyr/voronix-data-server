// The bridge to the CRM tables of the same business schema: clients,
// client_channels, services, masters, appointments, business_settings.
// The AI's ids are the CRM's codes (service HC-01, master MS-01), so a booking
// the AI makes becomes a real CRM appointment.
import type { Client, Tenant } from "./db.js";
import type { CrmSync } from "./config.js";
import { conflict } from "./errors.js";

export const MESSENGER: Record<string, "Telegram" | "WhatsApp" | "Instagram"> = {
  telegram: "Telegram",
  whatsapp: "WhatsApp",
  instagram: "Instagram",
};

const handles = (h: string) => [...new Set([h, h.replace(/^@/, "")].filter(Boolean))];

/** Finds the CRM client card for an AI client: its own link, a messenger account, or a CL- id. */
export async function findCrmClient(c: Client, ai: { id: string; channel: string; handle: string }): Promise<string | null> {
  const m = MESSENGER[ai.channel];
  if (m && ai.handle) {
    const r = await c.query<{ client_id: string }>(
      `SELECT client_id FROM client_channels WHERE messenger = $1 AND external_user_id = ANY($2::text[]) LIMIT 1`,
      [m, handles(ai.handle)],
    );
    if (r.rows[0]) return r.rows[0].client_id;
  }
  if (/^CL-\d{4,}$/.test(ai.id)) {
    const r = await c.query(`SELECT 1 FROM clients WHERE client_id = $1`, [ai.id]);
    if (r.rowCount) return ai.id;
  }
  return null;
}

/** Returns the CRM client for an AI client, creating the card (and its messenger account) if there is none. */
async function ensureCrmClient(c: Client, aiClientId: string): Promise<string> {
  const ai = (
    await c.query<{ id: string; name: string; channel: string; handle: string; crm_client_id: string | null }>(
      `SELECT id, name, channel, handle, crm_client_id FROM ai_clients WHERE id = $1 FOR UPDATE`,
      [aiClientId],
    )
  ).rows[0];
  if (!ai) throw new Error(`AI client ${aiClientId} does not exist`);
  if (ai.crm_client_id) return ai.crm_client_id;
  let crm = await findCrmClient(c, ai);
  if (!crm) {
    crm = (await c.query<{ client_id: string }>(`INSERT INTO clients (display_name) VALUES ($1) RETURNING client_id`, [ai.name.slice(0, 50)])).rows[0].client_id;
    const m = MESSENGER[ai.channel];
    if (m && ai.handle) {
      await c.query(`INSERT INTO client_channels (client_id, messenger, external_user_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [
        crm,
        m,
        ai.handle.slice(0, 64),
      ]);
    }
  }
  await c.query(`UPDATE ai_clients SET crm_client_id = $2 WHERE id = $1`, [ai.id, crm]);
  return crm;
}

export interface BookingForSync {
  id: string;
  client: string;
  service: string;
  staff: string;
  start: string;
  minutes: number;
  status: "booked" | "cancelled";
  source: string;
}

/**
 * Writes an AI booking into CRM appointments (inside the caller's
 * transaction, behind a savepoint). A busy slot always refuses the booking;
 * other CRM refusals depend on CRM_SYNC.
 */
export async function syncBooking(c: Client, b: BookingForSync, mode: CrmSync): Promise<void> {
  if (mode === "off") return;
  const known = await c.query(`SELECT 1 FROM master_services WHERE master_id = $1 AND service_code = $2`, [b.staff, b.service]);
  if (!known.rowCount) {
    await c.query(`UPDATE ai_bookings SET sync_status = 'skipped', sync_error = $2 WHERE id = $1`, [
      b.id,
      `CRM has no master ${b.staff} doing service ${b.service}`,
    ]);
    if (mode === "strict") throw conflict(`CRM has no master ${b.staff} doing service ${b.service}`);
    return;
  }
  await c.query("SAVEPOINT crm_sync");
  try {
    const linked = (await c.query<{ crm_appointment_id: string | null }>(`SELECT crm_appointment_id FROM ai_bookings WHERE id = $1`, [b.id])).rows[0]
      ?.crm_appointment_id;
    const end = `(($2)::timestamp + ($3::int) * INTERVAL '1 minute')`;
    if (!linked) {
      if (b.status !== "booked") {
        await c.query("RELEASE SAVEPOINT crm_sync");
        return;
      }
      const crmClient = await ensureCrmClient(c, b.client);
      const ap = (
        await c.query<{ appointment_id: string }>(
          `INSERT INTO appointments (client_id, master_id, service_code, start_at, end_at, status, source)
           VALUES ($1, $4, $5, $2::timestamp, ${end}, 'Booked', $6) RETURNING appointment_id`,
          [crmClient, b.start, b.minutes, b.staff, b.service, MESSENGER[b.source] ?? "Admin"],
        )
      ).rows[0].appointment_id;
      await c.query(`UPDATE ai_bookings SET crm_appointment_id = $2, sync_status = 'synced', sync_error = NULL WHERE id = $1`, [b.id, ap]);
    } else {
      await c.query(
        `UPDATE appointments SET master_id = $4, service_code = $5, start_at = $2::timestamp, end_at = ${end},
                status = CASE WHEN $6 = 'cancelled' THEN 'Cancelled'
                              WHEN status = 'Cancelled' THEN 'Booked'
                              ELSE status END
          WHERE appointment_id = $1
            AND (master_id, service_code, start_at, end_at, status = 'Cancelled')
                IS DISTINCT FROM ($4, $5, $2::timestamp, ${end}, $6 = 'cancelled')`,
        [linked, b.start, b.minutes, b.staff, b.service, b.status],
      );
      await c.query(`UPDATE ai_bookings SET sync_status = 'synced', sync_error = NULL WHERE id = $1`, [b.id]);
    }
    await c.query("RELEASE SAVEPOINT crm_sync");
  } catch (e) {
    await c.query("ROLLBACK TO SAVEPOINT crm_sync");
    const code = (e as { code?: string }).code;
    if (code === "23P01" || mode === "strict") throw e;
    await c.query(`UPDATE ai_bookings SET sync_status = 'failed', sync_error = $2 WHERE id = $1`, [b.id, (e as Error).message.slice(0, 500)]);
  }
}

/** Status change or move of a visit that the staff booked in the CRM (ids AP-…). */
export async function updateCrmVisit(c: Client, id: string, b: { start?: string; minutes?: number; status?: string }): Promise<boolean> {
  const cur = (await c.query<{ status: string }>(`SELECT status FROM appointments WHERE appointment_id = $1 FOR UPDATE`, [id])).rows[0];
  if (!cur) return false;
  const status = b.status === "cancelled" ? "Cancelled" : cur.status === "Cancelled" && b.status === "booked" ? "Booked" : cur.status;
  if (b.start && b.minutes) {
    await c.query(`UPDATE appointments SET start_at = $2::timestamp, end_at = $2::timestamp + $3::int * INTERVAL '1 minute', status = $4 WHERE appointment_id = $1`, [
      id,
      b.start,
      b.minutes,
      status,
    ]);
  } else if (status !== cur.status) {
    await c.query(`UPDATE appointments SET status = $2 WHERE appointment_id = $1`, [id, status]);
  }
  return true;
}

// ------------------------------------------------------------------ business profile

export interface AiService {
  id: string;
  names: { ru: string; kk: string; en: string };
  minutes: number;
  price: number;
  stems: string[];
}
export interface AiStaff {
  id: string;
  name: string;
  role: string;
  days: number[];
  from: string;
  to: string;
  services: string[];
}
export interface AiBusiness {
  name: string;
  city: string;
  address: { ru: string; kk: string; en: string };
  from: string;
  to: string;
  phone: string;
  currency: string;
  services: AiService[];
  staff: AiStaff[];
  [k: string]: unknown;
}

/** The AI writes prices with a symbol: 7 000 ₸. */
const SYMBOL: Record<string, string> = { KZT: "₸", RUB: "₽", USD: "$", EUR: "€", KGS: "сом", UZS: "сўм" };

/** Word starts the AI looks for in a message: "Мужская стрижка" → ["мужск", "стриж"]. */
export function stemsOf(name: string): string[] {
  const words = name.toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, " ").split(/[\s-]+/).filter((w) => w.length >= 3);
  return [...new Set(words.map((w) => (w.length > 6 ? w.slice(0, 5) : w)))];
}

/**
 * The business profile in the shape the AI uses (settings/business), built
 * from the CRM: services, masters and their services, hours, address. Names
 * and stems the AI already has for a service are kept.
 */
export async function businessFromCrm(c: Client, t: Tenant, keep?: Partial<AiBusiness>): Promise<AiBusiness> {
  const s = (await c.query(`SELECT * FROM business_settings WHERE id = 1`)).rows[0] ?? {};
  const services = (
    await c.query<{ service_code: string; name: string; duration_min: number; price_kzt: number }>(
      // Codes are numbered in the order services were added (HC-01, HC-02, KD-03 ...):
      // the AI prefers earlier services when a word fits several.
      `SELECT service_code, name, duration_min, price_kzt FROM services WHERE is_active ORDER BY right(service_code, 2), service_code`,
    )
  ).rows;
  const masters = (
    await c.query<{ master_id: string; full_name: string; specialization: string; work_start: string; work_end: string; work_days: number[]; services: string[] }>(
      `SELECT m.master_id, m.full_name, m.specialization,
              to_char(m.work_start, 'HH24:MI') AS work_start, to_char(m.work_end, 'HH24:MI') AS work_end, m.work_days,
              coalesce(array_agg(ms.service_code ORDER BY ms.service_code) FILTER (WHERE ms.service_code IS NOT NULL), '{}') AS services
         FROM masters m LEFT JOIN master_services ms ON ms.master_id = m.master_id
        WHERE m.is_active
        GROUP BY m.master_id ORDER BY m.master_id`,
    )
  ).rows;
  const old = new Map((keep?.services ?? []).map((x) => [x.id, x]));
  const addr = String(s.address ?? "");
  const from = masters.length ? masters.map((m) => m.work_start).sort()[0] : "09:00";
  const to = masters.length ? masters.map((m) => m.work_end).sort().at(-1)! : "20:00";
  return {
    ...(keep ?? {}),
    name: String(s.name ?? t.name),
    city: String(s.city ?? ""),
    address: { ru: addr, kk: addr, en: addr },
    from,
    to,
    phone: String(s.phone ?? ""),
    currency: SYMBOL[t.currency] ?? t.currency,
    services: services.map((x) => {
      const prev = old.get(x.service_code);
      return {
        id: x.service_code,
        names: prev?.names ?? { ru: x.name, kk: x.name, en: x.name },
        minutes: x.duration_min,
        price: x.price_kzt,
        stems: prev?.stems?.length ? prev.stems : stemsOf(x.name),
      };
    }),
    staff: masters.map((m) => ({
      id: m.master_id,
      name: m.full_name,
      role: m.specialization,
      days: m.work_days.map(Number),
      from: m.work_start,
      to: m.work_end,
      services: m.services,
    })),
  };
}
