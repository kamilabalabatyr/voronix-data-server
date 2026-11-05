// Live changes. PostgreSQL triggers send every change in the AI tables (and in
// CRM appointments) on the channel "ai_changes". One listening connection per
// server process turns them into Server-Sent Events for the AI pages that
// watch that business. Changes to the same row within 40 ms are sent once.
import pg from "pg";
import type { Tenant } from "./db.js";
import type { Collection, Row } from "./collections.js";

export interface LiveChange {
  col: Collection;
  type: "upsert" | "removed";
  row: Row;
}

interface Subscriber {
  tenant: Tenant;
  cols: Set<Collection>;
  send(changes: LiveChange[]): void;
}

type Loader = (t: Tenant, col: Collection, id: string) => Promise<Row | null>;

export class LiveHub {
  private client: pg.Client | null = null;
  private subs = new Map<string, Set<Subscriber>>();
  private pending = new Map<string, Map<string, { col: Collection; id: string }>>();
  private timers = new Map<string, NodeJS.Timeout>();
  private stopped = false;

  constructor(
    private readonly url: string,
    private readonly load: Loader,
    private readonly tenantOf: (schema: string) => Tenant | undefined,
    private readonly onError: (e: unknown) => void = () => {},
  ) {}

  async start(): Promise<void> {
    this.stopped = false;
    const c = new pg.Client({ connectionString: this.url });
    c.on("notification", (n) => n.payload && this.onNotify(n.payload));
    c.on("error", (e) => {
      this.onError(e);
      this.client = null;
      if (!this.stopped) setTimeout(() => void this.start().catch(this.onError), 1000);
    });
    await c.connect();
    await c.query("LISTEN ai_changes");
    this.client = c;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const t of this.timers.values()) clearTimeout(t);
    await this.client?.end().catch(() => {});
    this.client = null;
  }

  subscribe(s: Subscriber): () => void {
    let set = this.subs.get(s.tenant.schema);
    if (!set) this.subs.set(s.tenant.schema, (set = new Set()));
    set.add(s);
    return () => set!.delete(s);
  }

  private onNotify(payload: string) {
    let n: { schema: string; col: Collection; id: string };
    try {
      n = JSON.parse(payload);
    } catch {
      return;
    }
    if (!n.id || !this.subs.get(n.schema)?.size) return;
    let p = this.pending.get(n.schema);
    if (!p) this.pending.set(n.schema, (p = new Map()));
    p.set(`${n.col}/${n.id}`, { col: n.col, id: n.id });
    if (!this.timers.has(n.schema)) this.timers.set(n.schema, setTimeout(() => void this.flush(n.schema), 40));
  }

  private async flush(schema: string) {
    this.timers.delete(schema);
    const items = [...(this.pending.get(schema)?.values() ?? [])];
    this.pending.delete(schema);
    const subs = this.subs.get(schema);
    const tenant = this.tenantOf(schema);
    if (!subs?.size || !tenant) return;
    const wanted = new Set([...subs].flatMap((s) => [...s.cols]));
    const changes: LiveChange[] = [];
    for (const it of items) {
      if (!wanted.has(it.col)) continue;
      try {
        const row = await this.load(tenant, it.col, it.id);
        changes.push(row ? { col: it.col, type: "upsert", row } : { col: it.col, type: "removed", row: { id: it.id } });
      } catch (e) {
        this.onError(e);
      }
    }
    for (const s of subs) {
      const mine = changes.filter((ch) => s.cols.has(ch.col));
      if (mine.length) s.send(mine);
    }
  }
}
