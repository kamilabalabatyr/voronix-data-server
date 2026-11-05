export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export const badRequest = (msg: string, details?: Record<string, unknown>) => new HttpError(400, "bad_request", msg, details);
export const notFound = (msg: string) => new HttpError(404, "not_found", msg);
export const conflict = (msg: string, details?: Record<string, unknown>) => new HttpError(409, "conflict", msg, details);

interface PgError {
  code?: string;
  constraint?: string;
  detail?: string;
  message: string;
}

/** Turns a PostgreSQL refusal into an answer the AI can act on. */
export function fromPg(e: unknown): HttpError | null {
  const err = e as PgError;
  if (!err || typeof err.code !== "string") return null;
  const details = { constraint: err.constraint, pg: err.code, detail: err.detail };
  switch (err.code) {
    case "23P01":
      return new HttpError(409, "slot_taken", "This master already has a visit at that time.", details);
    case "23505":
      return new HttpError(409, "duplicate", err.message, details);
    case "23503":
      return err.message.includes("still referenced") || err.message.includes("update or delete")
        ? new HttpError(409, "in_use", err.message, details)
        : new HttpError(400, "unknown_reference", err.message, details);
    case "23502":
    case "23514":
    case "22P02":
    case "22007":
    case "22008":
    case "22001":
    case "22003":
    case "22023":
      return new HttpError(400, "invalid", err.message, details);
    default:
      return null;
  }
}
