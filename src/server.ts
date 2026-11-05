import { loadConfig } from "./config.js";
import { createPool, migrateAll } from "./db.js";
import { createApp } from "./app.js";

const config = loadConfig();
const pool = createPool(config.databaseUrl);

const applied = await migrateAll(pool);
if (applied.length) console.log(`migrations applied:\n  ${applied.join("\n  ")}`);

const server = createApp({ pool, config });
await server.start();
const http = server.app.listen(config.port, () => {
  console.log(`VoroniX data server on http://localhost:${config.port}  (CRM sync: ${config.crmSync}${config.allowNoAuth ? ", LOCAL MODE without keys" : ""})`);
});

const shutdown = async () => {
  http.close();
  await server.stop();
  await pool.end();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
