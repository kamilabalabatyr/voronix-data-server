// A copy of the Store interface of voronix-ai (apps/voronix-ai/src/live/store.ts),
// so server-store.ts compiles and is tested here. In the AI repository, put
// server-store.ts next to the real store.ts and delete nothing: the import
// "./store.js" then uses the AI's own file.

export type Row = { id: string } & Record<string, unknown>;
export type Change = { type: "added" | "modified" | "removed"; row: Row };
export const COLLECTIONS = ["phrases", "queue", "knowledge", "clients", "bookings", "versions", "events", "settings"] as const;
export type Collection = (typeof COLLECTIONS)[number];
type Listener = (rows: Row[], changes: Change[]) => void;

export interface Store {
  readonly kind: "site" | "memory";
  all(col: Collection): Promise<Row[]>;
  put(col: Collection, row: Row): Promise<void>;
  patch(col: Collection, id: string, data: Record<string, unknown>): Promise<void>;
  remove(col: Collection, id: string): Promise<void>;
  watch(col: Collection, cb: Listener): () => void;
}
