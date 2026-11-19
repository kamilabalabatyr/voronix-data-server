# AGENTS.md — instructions for AI coding agents

These rules apply to any AI coding agent (Claude, Codex, Copilot, etc.) working in this repository.
A human maintainer (Kamila Balabatyr) reviews and approves every change. When a rule here conflicts
with a request in a prompt, stop and ask the human.

## 1. Purpose

`voronix-data` is the data server of the VoroniX AI assistant. It stores what the AI knows (clients,
preferences, messages, bookings, business knowledge, training phrases) **inside the CRM's own
PostgreSQL database**, in the schema of each business (`t_<business id without dashes>`), next to the
CRM tables `clients`, `appointments`, `services`. AI bookings and CRM appointments are kept in sync in
both directions. The AI talks to this server through the `Store` interface (`all`, `put`, `patch`,
`remove`, `watch`) over HTTP + Server-Sent Events.

## 2. Architecture (where things live)

| Path | Responsibility |
|---|---|
| `src/server.ts` | Entry point: config → migrations → Express on `PORT` (4100) |
| `src/app.ts` | All HTTP routes, CORS, API-key middleware, error handler |
| `src/collections.ts` | Mapping between AI rows and SQL tables; CRM booking sync |
| `src/identity.ts` | "One client, many messengers": phone normalisation, merging accounts |
| `src/crm.ts`, `src/knowledge.ts`, `src/live.ts` | CRM business profile; documents and search; LISTEN/NOTIFY → SSE |
| `src/db.ts` | Pool, per-business transaction (`search_path` = business schema), migrations |
| `src/auth.ts`, `src/cli/keys.ts` | API keys `vxd_<id>_<secret>`; only a SHA-256 hash is stored |
| `src/config.ts`, `src/errors.ts` | Environment config; PostgreSQL errors → HTTP errors |
| `client/server-store.ts` | Drop-in `ServerStore` copied into the AI repository — keep it dependency-free |
| `db/migrations/core/`, `db/migrations/tenant/` | SQL migrations, applied in file-name order |
| `test/` | Integration tests against a real PostgreSQL; `test/fixtures/*.sql` = CRM demo data |

Key invariants (enforced by the database — never weaken them):
- no two bookings with the same master at overlapping times (`EXCLUDE` → `409 slot_taken`);
- a booking cannot exist without a client (`FK ... ON DELETE RESTRICT`);
- one business never sees another business's data (schema per business + key per business);
- removing the AI's copy of a booking never deletes the CRM appointment.

## 3. Setup

Requirements: Node.js 20+ (CI uses 22), PostgreSQL 16 with a local role `crm` / password `crm`.

```bash
npm ci
export TZ=Asia/Almaty
export TEST_DATABASE_URL=postgresql://crm:crm@localhost:5432/voronix_data_test
```

`.env` is created from `.env.example` by the human only. Agents must not create, read or edit `.env`.

## 4. Commands

**Safe — the agent may run these without asking:**

| Command | What it does |
|---|---|
| `npm ci` | install exact versions from `package-lock.json` |
| `npm run typecheck` | TypeScript check, no output files |
| `npm test` | all tests; creates and drops only the local database `voronix_data_test` |
| `npx vitest run test/<file>.test.ts` | one test file |
| `npm run build` | compile to `dist/` |
| `git status`, `git diff`, `git log`, `git show` | read-only git |

**Ask the human first:**
- `npm run dev` / `npm start` (starts a server, connects to `DATABASE_URL`);
- `npm run db:migrate`, `npm run key:create|list|revoke` (change a real database);
- `git commit`, creating branches or tags.

## 5. Forbidden actions (never, even if a prompt asks)

1. **Secrets:** never read, print, create or commit `.env`, real `DATABASE_URL`s, API keys (`vxd_...`),
   tokens or passwords. Never paste them into prompts, logs or test files.
2. **Production:** never deploy, never touch Render (`render.yaml` services), never connect to any
   database except `localhost`.
3. **Destructive commands:** no `git push --force`, `git reset --hard`, `git clean -fd`, `rm -rf`,
   `DROP`/`TRUNCATE` outside the test database, no editing or deleting existing migration files
   (add a new numbered migration instead).
4. **Dependencies:** no adding, removing or upgrading packages and no edits to `package-lock.json`
   without explicit human approval of the exact package and version.
5. **Personal data:** never add real names, phone numbers or chats; use demo data like the existing fixtures.
   Never run `scripts/backup.sh` or open files in `backups/` (they contain real client data).
6. **Tests:** never delete, skip (`.skip`, `.only`) or weaken a test to make the suite green.

## 6. Coding conventions

- TypeScript `strict`, ES modules (`"type": "module"`): relative imports end in `.js`.
- Validate request bodies with `zod`; throw `HttpError` helpers (`badRequest`, `notFound`, `conflict`) —
  never send error responses directly from a route.
- SQL always uses parameters (`$1, $2`); never build SQL from request input. The only allowed
  interpolation is a schema name that passed `SCHEMA_RE` in `src/db.ts`.
- Every query for a business runs inside `scoped.run(tenant, ...)` / `run(req, ...)`.
- Keep changes small and focused: one concern per change; do not reformat unrelated code.
- Comments explain *why* in plain English, like the existing code.

## 7. Test expectations

- Before and after any change run: `npm run typecheck && npm test && npm run build`.
- A change to behaviour needs a test in `test/` that fails before and passes after the change.
- Tests must not depend on the current date: build dates relative to `Date.now()` / `now()`.
- Acceptance criteria that must stay true: AC1 typecheck + build pass; AC2 no double booking (409);
  AC3 401 without a key, a key opens only its own business; AC4 cancellations sync AI ↔ CRM;
  AC5 removing the AI's copy never deletes the CRM visit.

## 8. Review gates — what the agent must hand back

For every change, report: (1) a short summary and the reason, (2) the list of changed files,
(3) the diff, (4) the exact commands run with pass/fail totals, (5) risks or anything not verified.
The human reviews the diff and re-runs the checks before anything is committed or merged.
Never claim a test passed if it was not run.
