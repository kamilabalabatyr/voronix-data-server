// npm run key:create -- <business id or name>
// npm run key:list
// npm run key:revoke -- <key id>
import { loadConfig } from "../config.js";
import { createPool, migrateCore } from "../db.js";
import { createKey, revokeKey } from "../auth.js";

const [cmd, arg, label] = process.argv.slice(2);
const pool = createPool(loadConfig().databaseUrl);

try {
  await migrateCore(pool);
  if (cmd === "create") {
    if (!arg) throw new Error("Which business? npm run key:create -- <business id or name>");
    const found = (
      await pool.query<{ business_id: string; name: string }>(
        `SELECT business_id, name FROM public.businesses WHERE business_id::text = $1 OR lower(name) = lower($1)`,
        [arg],
      )
    ).rows;
    if (found.length !== 1) throw new Error(found.length ? `Several businesses are called ${arg}: use the id` : `No business ${arg}`);
    const { key, keyId } = await createKey(pool, found[0].business_id, label);
    console.log(`Key for ${found[0].name} (id ${keyId}). It is shown only now, keep it secret:\n\n${key}\n`);
  } else if (cmd === "list") {
    const rows = (
      await pool.query(
        `SELECT k.key_id, b.name AS business, k.label, k.created_at::date AS created, k.last_used_at, k.revoked_at IS NOT NULL AS revoked
           FROM public.ai_api_keys k JOIN public.businesses b USING (business_id) ORDER BY k.created_at`,
      )
    ).rows;
    console.table(rows);
  } else if (cmd === "revoke") {
    if (!arg) throw new Error("Which key? npm run key:revoke -- <key id>");
    console.log((await revokeKey(pool, arg)) ? `Key ${arg} revoked` : `No active key ${arg}`);
  } else {
    console.log("Commands: create <business>, list, revoke <key id>");
  }
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
