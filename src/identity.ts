// One person, many messengers. Each AI client is one account (Instagram,
// Telegram, WhatsApp); the CRM client is the person. This file decides which
// CRM client an account belongs to and joins two CRM cards of one person.
import type { Client } from "./db.js";
import { MESSENGER } from "./crm.js";
import { badRequest, notFound } from "./errors.js";

/** '+7 (700) 123-45-67', '8 700 123 4567', '7001234567' → '+77001234567'; null if it is not a phone. */
export function normPhone(p: unknown): string | null {
  if (typeof p !== "string" && typeof p !== "number") return null;
  const d = String(p).replace(/\D/g, "");
  if (/^8\d{10}$/.test(d)) return `+7${d.slice(1)}`;
  if (/^\d{10}$/.test(d)) return `+7${d}`;
  if (/^\d{11,15}$/.test(d)) return `+${d}`;
  return null;
}

/**
 * A phone the client wrote in a message: "мой номер 8 701 234 56 78",
 * "+7(701)2345678". Only Kazakhstan / Russia numbers (+7), so order numbers
 * or prices are not taken for a phone.
 */
export function phoneInText(text: string): string | null {
  const m = /(?:^|[^\d+])((?:\+7|8|7)[\s\-()]*\d{3}[\s\-()]*\d{3}[\s\-]*\d{2}[\s\-]*\d{2})(?!\d)/.exec(text);
  return m ? normPhone(m[1]) : null;
}

/** A WhatsApp account is a phone number. */
export const phoneOfHandle = (channel: string, handle: string) => (channel === "whatsapp" ? normPhone(handle) : null);

interface Account {
  id: string;
  name: string;
  channel: string;
  handle: string;
  phone: string | null;
  crm_client_id: string | null;
}

/**
 * Moves everything of CRM client `from` to `into` and deletes `from`:
 * messenger accounts, visits, chats, AI accounts, phone and notes.
 */
export async function mergeCrmClients(c: Client, into: string, from: string): Promise<void> {
  if (into === from) return;
  const rows = (
    await c.query<{ client_id: string; phone: string | null; notes: string }>(
      `SELECT client_id, phone, notes FROM clients WHERE client_id = ANY($1) ORDER BY client_id FOR UPDATE`,
      [[into, from]],
    )
  ).rows;
  const a = rows.find((r) => r.client_id === into);
  const b = rows.find((r) => r.client_id === from);
  if (!a || !b) return;
  await c.query(`UPDATE client_channels SET client_id = $1 WHERE client_id = $2`, [into, from]);
  await c.query(`UPDATE appointments SET client_id = $1 WHERE client_id = $2`, [into, from]);
  await c.query(`UPDATE conversations SET client_id = $1 WHERE client_id = $2`, [into, from]);
  await c.query(`UPDATE ai_clients SET crm_client_id = $1 WHERE crm_client_id = $2`, [into, from]);
  // The phone is unique in the CRM: free it on the old card first.
  await c.query(`UPDATE clients SET phone = NULL WHERE client_id = $1`, [from]);
  const notes = [a.notes, b.notes].map((n) => n.trim()).filter(Boolean);
  await c.query(`UPDATE clients SET phone = coalesce(phone, $2), notes = $3 WHERE client_id = $1`, [into, b.phone, [...new Set(notes)].join("\n")]);
  await c.query(`DELETE FROM clients WHERE client_id = $1`, [from]);
}

/**
 * Finds the person (CRM client) for one AI account and links it. Every CRM
 * card that is certainly the same person is joined into the oldest one:
 *  - the card already linked to this account;
 *  - the card that owns this messenger account in client_channels;
 *  - the card with the same phone;
 *  - the cards of other AI accounts with the same phone.
 * Returns the CRM client id, or null if the person has no CRM card yet.
 */
export async function resolvePerson(c: Client, aiClientId: string): Promise<string | null> {
  const ai = (await c.query<Account>(`SELECT id, name, channel, handle, phone, crm_client_id FROM ai_clients WHERE id = $1 FOR UPDATE`, [aiClientId])).rows[0];
  if (!ai) return null;
  const found = new Set<string>();
  if (ai.crm_client_id) found.add(ai.crm_client_id);
  const m = MESSENGER[ai.channel];
  if (m && ai.handle) {
    for (const r of (
      await c.query<{ client_id: string }>(`SELECT client_id FROM client_channels WHERE messenger = $1 AND external_user_id = ANY($2::text[])`, [
        m,
        [...new Set([ai.handle, ai.handle.replace(/^@/, "")])],
      ])
    ).rows)
      found.add(r.client_id);
  }
  if (/^CL-\d{4,}$/.test(ai.id) && (await c.query(`SELECT 1 FROM clients WHERE client_id = $1`, [ai.id])).rowCount) found.add(ai.id);
  if (ai.phone) {
    for (const r of (await c.query<{ client_id: string }>(`SELECT client_id FROM clients WHERE ai_norm_phone(phone) = $1`, [ai.phone])).rows) found.add(r.client_id);
    for (const r of (
      await c.query<{ crm_client_id: string }>(`SELECT crm_client_id FROM ai_clients WHERE phone = $1 AND crm_client_id IS NOT NULL`, [ai.phone])
    ).rows)
      found.add(r.crm_client_id);
  }
  if (!found.size) return null;
  const keep = await oldest(c, [...found]);
  for (const other of found) if (other !== keep) await mergeCrmClients(c, keep, other);
  await attach(c, ai, keep);
  await linkSamePhone(c, ai.phone, keep);
  return keep;
}

async function oldest(c: Client, ids: string[]): Promise<string> {
  return (await c.query<{ client_id: string }>(`SELECT client_id FROM clients WHERE client_id = ANY($1) ORDER BY created_at, client_id LIMIT 1`, [ids])).rows[0].client_id;
}

/** Links the account to the CRM client: the AI link, the messenger account in the CRM, the phone if the card has none. */
async function attach(c: Client, ai: Account, crm: string): Promise<void> {
  await c.query(`UPDATE ai_clients SET crm_client_id = $2 WHERE id = $1 AND crm_client_id IS DISTINCT FROM $2`, [ai.id, crm]);
  const m = MESSENGER[ai.channel];
  if (m && ai.handle) {
    await c.query(`INSERT INTO client_channels (client_id, messenger, external_user_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [crm, m, ai.handle.slice(0, 64)]);
  }
  if (ai.phone) {
    const taken = (await c.query(`SELECT 1 FROM clients WHERE ai_norm_phone(phone) = $1 AND client_id <> $2`, [ai.phone, crm])).rowCount;
    if (!taken) await c.query(`UPDATE clients SET phone = $2 WHERE client_id = $1 AND phone IS NULL`, [crm, ai.phone]);
  }
}

/** Creates a CRM card for an account that has none (used when it books). */
export async function createPerson(c: Client, aiClientId: string): Promise<string> {
  const ai = (await c.query<Account>(`SELECT id, name, channel, handle, phone, crm_client_id FROM ai_clients WHERE id = $1 FOR UPDATE`, [aiClientId])).rows[0];
  if (!ai) throw notFound(`AI client ${aiClientId} does not exist`);
  const crm = (await c.query<{ client_id: string }>(`INSERT INTO clients (display_name, phone) VALUES ($1, $2) RETURNING client_id`, [ai.name.slice(0, 50), ai.phone])).rows[0].client_id;
  await attach(c, ai, crm);
  await linkSamePhone(c, ai.phone, crm);
  return crm;
}

/** Other accounts with the same phone and no card yet are the same person: link them and their messengers. */
async function linkSamePhone(c: Client, phone: string | null, crm: string): Promise<void> {
  if (!phone) return;
  const others = (await c.query<Account>(`SELECT id, name, channel, handle, phone, crm_client_id FROM ai_clients WHERE phone = $1 AND crm_client_id IS NULL`, [phone])).rows;
  for (const o of others) await attach(c, o, crm);
}

/** A person said these two accounts are the same client: one CRM card for both. */
export async function mergeAccounts(c: Client, a: string, b: string): Promise<string> {
  if (a === b) throw badRequest("Pick two different clients");
  const pa = (await resolvePerson(c, a)) ?? (await createPerson(c, a));
  const pb = (await resolvePerson(c, b)) ?? (await createPerson(c, b));
  const keep = await oldest(c, [pa, pb]);
  await mergeCrmClients(c, keep, keep === pa ? pb : pa);
  for (const id of [a, b]) {
    const acc = (await c.query<Account>(`SELECT id, name, channel, handle, phone, crm_client_id FROM ai_clients WHERE id = $1`, [id])).rows[0];
    await attach(c, acc, keep);
  }
  await c.query(`DELETE FROM ai_distinct_clients WHERE (client_a, client_b) = ($1, $2)`, a < b ? [a, b] : [b, a]);
  return keep;
}

/** A person said these two accounts are different people: never suggest them again. */
export async function markDistinct(c: Client, a: string, b: string): Promise<void> {
  if (a === b) throw badRequest("Pick two different clients");
  const [x, y] = a < b ? [a, b] : [b, a];
  await c.query(`INSERT INTO ai_distinct_clients (client_a, client_b) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [x, y]);
}
