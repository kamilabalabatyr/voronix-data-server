// API keys. One key opens the data of one business. The key is shown once
// when it is made; the database keeps only a SHA-256 hash of its secret.
// Format: vxd_<key id>_<secret>
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Pool, Tenant } from "./db.js";
import { findTenant } from "./db.js";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const KEY_RE = /^vxd_([a-z0-9]{8,16})_([A-Za-z0-9_-]{20,})$/;

export async function createKey(pool: Pool, businessId: string, label = "VoroniX AI"): Promise<{ key: string; keyId: string }> {
  const keyId = randomBytes(8).toString("hex").slice(0, 12);
  const secret = randomBytes(24).toString("base64url");
  await pool.query(`INSERT INTO public.ai_api_keys (key_id, business_id, secret_hash, label) VALUES ($1, $2, $3, $4)`, [keyId, businessId, sha256(secret), label]);
  return { key: `vxd_${keyId}_${secret}`, keyId };
}

export async function revokeKey(pool: Pool, keyId: string): Promise<boolean> {
  return ((await pool.query(`UPDATE public.ai_api_keys SET revoked_at = now() WHERE key_id = $1 AND revoked_at IS NULL`, [keyId])).rowCount ?? 0) > 0;
}

export class KeyCheck {
  private cache = new Map<string, { tenant: Tenant | null; until: number }>();
  private touched = new Map<string, number>();
  constructor(private readonly pool: Pool) {}

  /** The business a key opens, or null. Answers are cached for 30 s. */
  async tenantFor(key: string): Promise<Tenant | null> {
    const m = KEY_RE.exec(key);
    if (!m) return null;
    const hit = this.cache.get(key);
    if (hit && hit.until > Date.now()) return hit.tenant;
    const [, keyId, secret] = m;
    const row = (
      await this.pool.query<{ business_id: string; secret_hash: string }>(
        `SELECT business_id, secret_hash FROM public.ai_api_keys WHERE key_id = $1 AND revoked_at IS NULL`,
        [keyId],
      )
    ).rows[0];
    let tenant: Tenant | null = null;
    if (row && timingSafeEqual(Buffer.from(row.secret_hash), Buffer.from(sha256(secret)))) tenant = await findTenant(this.pool, row.business_id);
    this.cache.set(key, { tenant, until: Date.now() + 30_000 });
    if (tenant && (this.touched.get(keyId) ?? 0) < Date.now() - 60_000) {
      this.touched.set(keyId, Date.now());
      void this.pool.query(`UPDATE public.ai_api_keys SET last_used_at = now() WHERE key_id = $1`, [keyId]).catch(() => {});
    }
    return tenant;
  }

  forget() {
    this.cache.clear();
  }
}
