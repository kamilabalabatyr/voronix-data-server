import "dotenv/config";

const bool = (v: string | undefined) => v === "true" || v === "1";

export type CrmSync = "loose" | "strict" | "off";

export interface Config {
  databaseUrl: string;
  port: number;
  corsOrigins: string[];
  crmSync: CrmSync;
  crmDaysBack: number;
  allowNoAuth: boolean;
  defaultBusinessId: string | null;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const sync = (env.CRM_SYNC ?? "loose") as CrmSync;
  if (!["loose", "strict", "off"].includes(sync)) throw new Error(`CRM_SYNC must be loose, strict or off, not ${sync}`);
  const allowNoAuth = bool(env.ALLOW_NO_AUTH);
  if (allowNoAuth && env.NODE_ENV === "production") throw new Error("ALLOW_NO_AUTH cannot be used with NODE_ENV=production");
  return {
    databaseUrl: env.DATABASE_URL ?? "postgresql://crm:crm@localhost:5432/crm",
    port: Number(env.PORT ?? 4100),
    corsOrigins: (env.CORS_ORIGINS ?? "*").split(",").map((s) => s.trim()).filter(Boolean),
    crmSync: sync,
    crmDaysBack: Math.max(0, Number(env.CRM_DAYS_BACK ?? 60)),
    allowNoAuth,
    defaultBusinessId: env.DEFAULT_BUSINESS_ID || null,
  };
}
