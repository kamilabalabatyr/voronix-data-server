import { loadConfig } from "../config.js";
import { createPool, migrateAll } from "../db.js";

const pool = createPool(loadConfig().databaseUrl);
try {
  const applied = await migrateAll(pool);
  console.log(applied.length ? applied.map((f) => `applied ${f}`).join("\n") : "nothing to apply");
} finally {
  await pool.end();
}
