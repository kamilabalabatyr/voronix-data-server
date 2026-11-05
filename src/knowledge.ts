// What a business feeds to the AI: whole documents (price lists, rules,
// FAQ, promotions) are kept as they were sent and cut into knowledge entries
// the AI can search. Search covers these entries and the CRM's own
// knowledge_entries, ranked by PostgreSQL full-text search.
import { randomBytes } from "node:crypto";
import type { Client } from "./db.js";

const id = (prefix: string) => `${prefix}-${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
const CHUNK = 1200;

/** Cuts a text into pieces of about 1 200 characters at paragraph borders, each with a title. */
export function chunk(title: string, content: string): { title: string; text: string }[] {
  const paras = content
    .replace(/\r\n?/g, "\n")
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  const pieces: string[] = [];
  let cur = "";
  for (const p of paras) {
    // A paragraph longer than a piece is cut at sentence ends.
    const parts = p.length <= CHUNK ? [p] : p.match(new RegExp(`[\\s\\S]{1,${CHUNK}}(?:[.!?…](?=\\s)|$)|[\\s\\S]{1,${CHUNK}}`, "g")) ?? [p];
    for (const part of parts) {
      if (cur && cur.length + part.length + 2 > CHUNK) {
        pieces.push(cur);
        cur = "";
      }
      cur = cur ? `${cur}\n\n${part.trim()}` : part.trim();
    }
  }
  if (cur) pieces.push(cur);
  return pieces.map((text, i) => {
    const first = text.split("\n")[0].trim();
    const heading = first.length <= 80 && !/[.!?,;:]$/.test(first) && text.includes("\n") ? first : "";
    const t = pieces.length === 1 ? title : heading ? `${title} · ${heading}` : `${title} · ${i + 1}/${pieces.length}`;
    return { title: t.slice(0, 200), text };
  });
}

export interface NewDocument {
  title: string;
  content: string;
  fileName?: string;
  mime?: string;
  source?: "business" | "operator" | "file";
  uploadedBy?: string;
  tags?: string[];
}

export async function addDocument(c: Client, d: NewDocument) {
  const documentId = id("doc");
  const source = d.source ?? (d.fileName ? "file" : "business");
  await c.query(
    `INSERT INTO ai_knowledge_documents (document_id, title, file_name, mime, content, source, uploaded_by) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [documentId, d.title.slice(0, 200), d.fileName ?? null, d.mime ?? "text/plain", d.content, source, d.uploadedBy ?? ""],
  );
  const entries = chunk(d.title, d.content).map((p, i) => ({ id: `${documentId}-${i + 1}`, ...p }));
  for (const e of entries) {
    await c.query(
      `INSERT INTO ai_knowledge (id, document_id, title, text, source, file, tags) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [e.id, documentId, e.title, e.text, source, d.fileName ?? null, d.tags ?? []],
    );
  }
  return { documentId, entries: entries.map((e) => ({ id: e.id, title: e.title, chars: e.text.length })) };
}

export async function listDocuments(c: Client) {
  return (
    await c.query(
      `SELECT d.document_id AS "documentId", d.title, d.file_name AS "fileName", d.mime, d.size_bytes AS "sizeBytes", d.source,
              d.uploaded_by AS "uploadedBy", d.uploaded_at AS "uploadedAt", count(k.id)::int AS entries
         FROM ai_knowledge_documents d LEFT JOIN ai_knowledge k ON k.document_id = d.document_id
        GROUP BY d.document_id ORDER BY d.uploaded_at DESC`,
    )
  ).rows;
}

export async function deleteDocument(c: Client, documentId: string): Promise<boolean> {
  return ((await c.query(`DELETE FROM ai_knowledge_documents WHERE document_id = $1`, [documentId])).rowCount ?? 0) > 0;
}

// Words that say nothing about the topic (Russian, Kazakh, English).
const STOP = new Set(
  "как что где когда какой какая какие есть ли мне вам вас нас для или это так там тут можно нужно хочу будет было при про над под без уже еще ещё очень сколько ну да нет бар жоқ ма ме ба бе па пе және мен сен бұл осы қалай қашан қандай керек the and for are you your can how what when where with have has does from that this there".split(" "),
);

/**
 * "Сколько стоит стрижка?" → ["стоит", "стриж"]. Words are cut to 5 letters
 * and matched as prefixes (стриж:*), so "стрижку" finds "стрижка" in Russian
 * and Kazakh without a dictionary.
 */
export function terms(q: string): string[] {
  const words = q
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  const useful = words.filter((w) => w.length >= 3 && !STOP.has(w));
  const pick = useful.length ? useful : words.filter((w) => w.length >= 2);
  return [...new Set(pick.map((w) => (w.length > 5 ? w.slice(0, 5) : w)))].slice(0, 20);
}

export function toQuery(q: string): string | null {
  const t = terms(q);
  return t.length ? t.map((w) => `${w}:*`).join(" | ") : null;
}

/** Entries that match more of the question's words come first, then by full-text rank. */
export async function search(c: Client, q: string, limit = 5) {
  const t = terms(q);
  if (!t.length) return [];
  return (
    await c.query(
      `SELECT id, title, origin, source, document_id AS "documentId",
              matched,
              round(ts_rank_cd(search, query, 32)::numeric, 4)::float AS score,
              ts_headline('simple', text, query, 'MaxFragments=2, MinWords=6, MaxWords=24, StartSel=«, StopSel=»') AS snippet,
              text
         FROM ai_knowledge_all,
              to_tsquery('simple', $1) AS query,
              LATERAL (SELECT count(*)::int AS matched FROM unnest($2::text[]) w WHERE search @@ to_tsquery('simple', w || ':*')) m
        WHERE search @@ query
        ORDER BY matched DESC, score DESC, id
        LIMIT $3`,
      [t.map((w) => `${w}:*`).join(" | "), t, Math.min(Math.max(limit, 1), 50)],
    )
  ).rows;
}
