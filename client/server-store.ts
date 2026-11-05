// ServerStore: the AI's Store interface on top of the VoroniX data server.
// Copy this file into voronix-ai next to src/live/store.ts and use it instead
// of SiteStore:
//
//   import { ServerStore } from "./server-store.js";
//   const store = new ServerStore({ url: "https://voronix-data.onrender.com", key: "vxd_..." });
//   const runtime = new LiveRuntime(store, ...);
//
// No dependencies: fetch and a streamed response, so it works in the browser
// and in Node 20+. Changes made anywhere (another page, the CRM staff, the
// server) arrive through one Server-Sent Events stream.
import type { Change, Collection, Row, Store } from "./store.js";

type Listener = (rows: Row[], changes: Change[]) => void;
const SETTLE_MS = 1500;

export interface ServerStoreOptions {
  /** Address of the data server, e.g. http://localhost:4100 */
  url: string;
  /** API key from `npm run key:create` (vxd_...). Not needed in local mode. */
  key?: string;
  /** Local mode only (ALLOW_NO_AUTH=true): which business. */
  businessId?: string;
  onError?: (e: { code: string; message: string }) => void;
  fetch?: typeof fetch;
}

export class ServerStoreError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export class ServerStore implements Store {
  /** Saved and shared by everyone, like the site database. */
  readonly kind = "site" as const;
  private readonly base: string;
  private readonly f: typeof fetch;
  private cache = new Map<Collection, Map<string, Row>>();
  private loading = new Map<Collection, Promise<void>>();
  private early = new Map<Collection, { type: "upsert" | "removed"; row: Row }[]>();
  private listeners = new Map<Collection, Set<Listener>>();
  private stream: AbortController | null = null;
  private streamCols = "";
  private retry = 0;
  private closed = false;
  private recent = new Map<string, number>();
  private settle = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly opts: ServerStoreOptions) {
    this.base = opts.url.replace(/\/+$/, "");
    this.f = opts.fetch ?? fetch.bind(globalThis);
  }

  private headers(json = false): Record<string, string> {
    const h: Record<string, string> = {};
    if (this.opts.key) h.Authorization = `Bearer ${this.opts.key}`;
    if (this.opts.businessId) h["X-Business-Id"] = this.opts.businessId;
    if (json) h["Content-Type"] = "application/json";
    return h;
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await this.f(`${this.base}${path}`, { method, headers: this.headers(body !== undefined), body: body === undefined ? undefined : JSON.stringify(body) });
    } catch (e) {
      const err = new ServerStoreError(0, "unavailable", `Data server is not reachable: ${(e as Error).message}`);
      this.opts.onError?.(err);
      throw err;
    }
    const data = (await res.json().catch(() => ({}))) as { error?: { code: string; message: string } & Record<string, unknown> } & T;
    if (!res.ok) {
      const { code = "error", message = res.statusText, ...details } = data.error ?? ({} as { code: string; message: string });
      const err = new ServerStoreError(res.status, code, message, details);
      this.opts.onError?.(err);
      throw err;
    }
    return data;
  }

  private path(col: Collection, id?: string) {
    return `/v1/store/${col}${id === undefined ? "" : `/${encodeURIComponent(id)}`}`;
  }

  async all(col: Collection): Promise<Row[]> {
    return (await this.call<{ rows: Row[] }>("GET", this.path(col))).rows;
  }

  async put(col: Collection, row: Row): Promise<void> {
    await this.call("PUT", this.path(col, row.id), row);
    this.local(col, { type: "upsert", row: JSON.parse(JSON.stringify(row)) as Row });
  }

  async patch(col: Collection, id: string, data: Record<string, unknown>): Promise<void> {
    const { row } = await this.call<{ row: Row }>("PATCH", this.path(col, id), data);
    this.local(col, { type: "upsert", row });
  }

  async remove(col: Collection, id: string): Promise<void> {
    await this.call("DELETE", this.path(col, id));
    this.local(col, { type: "removed", row: { id } });
  }

  /**
   * A write made here is shown to this page's watchers at once, like the site
   * database does. For a short time after it, the stream's copies of the same
   * row are not applied (they may be older than this write); the row is
   * fetched once when that time is over, so the page ends with the server's copy.
   */
  private local(col: Collection, ch: { type: "upsert" | "removed"; row: Row }) {
    if (!this.listeners.get(col)?.size) return;
    const key = `${col}/${ch.row.id}`;
    this.recent.set(key, Date.now());
    this.apply(col, ch);
  }

  private reconcile(col: Collection, id: string) {
    const key = `${col}/${id}`;
    clearTimeout(this.settle.get(key));
    const wait = SETTLE_MS - (Date.now() - (this.recent.get(key) ?? 0));
    this.settle.set(
      key,
      setTimeout(async () => {
        this.settle.delete(key);
        if (Date.now() - (this.recent.get(key) ?? 0) < SETTLE_MS) return this.reconcile(col, id);
        this.recent.delete(key);
        try {
          const { row } = await this.call<{ row: Row }>("GET", this.path(col, id));
          this.apply(col, { type: "upsert", row });
        } catch (e) {
          if ((e as ServerStoreError).status === 404) this.apply(col, { type: "removed", row: { id } });
        }
      }, Math.max(0, wait)),
    );
  }

  watch(col: Collection, cb: Listener): () => void {
    let set = this.listeners.get(col);
    if (!set) this.listeners.set(col, (set = new Set()));
    set.add(cb);
    this.closed = false;
    this.openStream();
    void this.load(col).then(() => {
      if (!set!.has(cb)) return;
      const rows = this.rows(col);
      cb(rows, rows.map((row) => ({ type: "added" as const, row })));
    });
    return () => {
      set!.delete(cb);
      if (![...this.listeners.values()].some((s) => s.size)) this.close();
    };
  }

  /** Stops the live stream (watchers stay registered until they unsubscribe). */
  close() {
    this.closed = true;
    for (const t of this.settle.values()) clearTimeout(t);
    this.settle.clear();
    this.stream?.abort();
    this.stream = null;
    this.streamCols = "";
  }

  private rows(col: Collection): Row[] {
    return [...(this.cache.get(col)?.values() ?? [])];
  }

  private load(col: Collection): Promise<void> {
    let p = this.loading.get(col);
    if (!p) {
      p = this.all(col)
        .then((rows) => {
          this.cache.set(col, new Map(rows.map((r) => [r.id, r])));
          const queued = this.early.get(col) ?? [];
          this.early.delete(col);
          for (const ch of queued) this.apply(col, ch, false);
        })
        .catch((e) => {
          this.loading.delete(col);
          throw e;
        });
      this.loading.set(col, p);
    }
    return p;
  }

  private apply(col: Collection, ch: { type: "upsert" | "removed"; row: Row }, notify = true) {
    const map = this.cache.get(col);
    if (!map) {
      // Not loaded yet: keep it until the first load is done.
      const q = this.early.get(col) ?? [];
      q.push(ch);
      this.early.set(col, q);
      return;
    }
    let change: Change;
    if (ch.type === "removed") {
      const old = map.get(ch.row.id);
      if (!old) return;
      map.delete(ch.row.id);
      change = { type: "removed", row: old };
    } else {
      change = { type: map.has(ch.row.id) ? "modified" : "added", row: ch.row };
      map.set(ch.row.id, ch.row);
    }
    if (!notify) return;
    const rows = this.rows(col);
    for (const cb of this.listeners.get(col) ?? []) cb(rows, [change]);
  }

  private openStream() {
    const cols = [...this.listeners.entries()]
      .filter(([, s]) => s.size)
      .map(([c]) => c)
      .sort()
      .join(",");
    if (!cols || (this.stream && cols === this.streamCols)) return;
    this.stream?.abort();
    const ctrl = new AbortController();
    this.stream = ctrl;
    this.streamCols = cols;
    void this.read(ctrl, cols);
  }

  private async read(ctrl: AbortController, cols: string) {
    try {
      const res = await this.f(`${this.base}/v1/watch?cols=${cols}`, { headers: { ...this.headers(), Accept: "text/event-stream" }, signal: ctrl.signal });
      if (!res.ok || !res.body) throw new Error(`watch answered ${res.status}`);
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i: number;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const event = /^event: (.*)$/m.exec(block)?.[1];
          const data = block
            .split("\n")
            .filter((l) => l.startsWith("data: "))
            .map((l) => l.slice(6))
            .join("\n");
          if (event === "ready") {
            this.retry = 0;
            // Changes made while the stream was down or reopening: reload what is already cached.
            await this.reloadAll();
          } else if (event === "changes" && data) {
            for (const ch of JSON.parse(data) as { col: Collection; type: "upsert" | "removed"; row: Row }[]) {
              const t = this.recent.get(`${ch.col}/${ch.row.id}`);
              if (t !== undefined && Date.now() - t < SETTLE_MS) this.reconcile(ch.col, ch.row.id);
              else this.apply(ch.col, ch);
            }
          }
        }
      }
      throw new Error("watch stream ended");
    } catch (e) {
      if (ctrl.signal.aborted || this.closed) return;
      this.opts.onError?.({ code: "unavailable", message: (e as Error).message });
      const wait = Math.min(30_000, 500 * 2 ** this.retry++) + Math.random() * 300;
      setTimeout(() => {
        if (this.stream !== ctrl || this.closed) return;
        this.stream = null;
        this.streamCols = "";
        this.openStream();
        void this.reloadAll();
      }, wait);
    }
  }

  /** Fetches watched collections again and tells watchers what changed. */
  private async reloadAll() {
    for (const [col, set] of this.listeners) {
      if (!set.size || !this.cache.has(col)) continue;
      const fresh = await this.all(col).catch(() => null);
      if (!fresh) continue;
      const old = this.cache.get(col)!;
      const next = new Map(fresh.map((r) => [r.id, r]));
      // Rows written here a moment ago: keep this page's copy, check them later.
      for (const [key, t] of this.recent) {
        if (!key.startsWith(`${col}/`) || Date.now() - t >= SETTLE_MS) continue;
        const id = key.slice(col.length + 1);
        const mine = old.get(id);
        if (mine) next.set(id, mine);
        else next.delete(id);
        this.reconcile(col, id);
      }
      const changes: Change[] = [];
      for (const [id, r] of next) if (!old.has(id)) changes.push({ type: "added", row: r });
      else if (JSON.stringify(old.get(id)) !== JSON.stringify(r)) changes.push({ type: "modified", row: r });
      for (const [id, r] of old) if (!next.has(id)) changes.push({ type: "removed", row: r });
      this.cache.set(col, next);
      if (changes.length) for (const cb of set) cb([...next.values()], changes);
    }
  }
}
