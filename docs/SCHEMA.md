# VoroniX AI data: schema

The AI tables live in the CRM's PostgreSQL, inside the schema of each business (`t_<id>`), next to the CRM tables. Migrations: [`db/migrations`](../db/migrations) (`core/` once per database, `tenant/` once per business, tracked in `ai_migrations`).

## ERD

CRM tables are grey boxes; the AI tables link to them.

```mermaid
erDiagram
  clients ||--o{ ai_clients : "crm_client_id (SET NULL)"
  appointments |o--o| ai_bookings : "crm_appointment_id UNIQUE"
  ai_clients ||--o{ ai_client_preferences : "client_id (CASCADE)"
  ai_clients ||--o{ ai_messages : "client_id (CASCADE)"
  ai_clients ||--o{ ai_bookings : "client_id (RESTRICT)"
  ai_knowledge_documents ||--o{ ai_knowledge : "document_id (CASCADE)"

  ai_clients {
    varchar id PK
    varchar crm_client_id FK
    varchar name
    varchar channel "instagram | telegram | whatsapp | crm"
    varchar handle
    char lang "ru | kk | en"
    timestamptz first_seen
    timestamptz last_seen
    int messages
    int bookings
    int cancels
    numeric mood "-1 .. 1"
    jsonb dialog
    jsonb extra
  }
  ai_client_preferences {
    varchar client_id PK,FK
    varchar kind PK "service | staff | time | language | note"
    varchar value PK
    int weight
    varchar source "learned | stated | staff"
  }
  ai_messages {
    bigserial message_id PK
    varchar client_id FK
    varchar sender "client | ai | staff"
    text text
    text_array labels
    timestamptz sent_at
  }
  ai_bookings {
    varchar id PK
    varchar client_id FK
    varchar service
    varchar staff
    timestamp start_at
    int minutes
    timestamp end_at "generated"
    numeric price
    varchar status "booked | cancelled"
    varchar crm_appointment_id FK
    varchar sync_status "synced | skipped | failed"
  }
  ai_knowledge_documents {
    varchar document_id PK
    varchar title
    varchar file_name
    text content
    int size_bytes "generated"
    varchar source
  }
  ai_knowledge {
    varchar id PK
    varchar document_id FK
    varchar title
    text text
    tsvector search "generated, GIN index"
  }
  ai_phrases {
    varchar id PK
    text text
    char lang
    text_array labels "10 known intents"
    varchar source "client | operator | business | auto"
    timestamptz learned_at
  }
  ai_review_queue {
    varchar id PK
    varchar kind "unsure | unanswered | complaint"
    text text
    numeric score
  }
  ai_model_versions {
    varchar id PK
    int n UK
    varchar status "only one live"
    jsonb metrics
  }
  clients {
    varchar client_id PK
  }
  appointments {
    varchar appointment_id PK
  }
```

`ai_phrases`, `ai_review_queue`, `ai_events` and `ai_settings` have no foreign keys on purpose: training data and logs must outlive a deleted client card.

## Relationships

| Relationship | Type | Business rule | How it is stored |
|---|---|---|---|
| ai_clients – clients | M:1 | Several AI cards (one per messenger) can belong to one real CRM client | `ai_clients.crm_client_id`, found from `client_channels` |
| ai_clients – ai_client_preferences | 1:M | A client has many preferences, each kind + value once | composite PK `(client_id, kind, value)` |
| ai_clients – ai_messages | 1:M | Full chat history | FK, `ON DELETE CASCADE` |
| ai_clients – ai_bookings | 1:M | A booking always has a client; a client with bookings cannot be deleted | FK, `ON DELETE RESTRICT` |
| ai_bookings – appointments | 1:1 | Each AI booking is one CRM visit | `crm_appointment_id UNIQUE` |
| ai_knowledge_documents – ai_knowledge | 1:M | A document is cut into pieces; deleting it deletes them | FK, `ON DELETE CASCADE` |

## Views

| View | Purpose |
|---|---|
| `ai_calendar` | AI bookings + CRM visits the AI did not make, one calendar |
| `ai_knowledge_all` | AI knowledge + CRM `knowledge_entries`, one searchable list |
| `ai_client_card` | One line per client: CRM name and phone, usual service, master and time, staff notes |
| `ai_training_set` | Training phrases in the AI's `phrases.tsv` shape |

Example: which clients prefer evenings and who is their usual barber?

```sql
SELECT name, crm_phone, usual_service, usual_staff
FROM ai_client_card
WHERE usual_time = 'evening'
ORDER BY bookings DESC;
```

## Live changes

Every `ai_*` table and the CRM `appointments` table have an `AFTER` trigger that calls `public.ai_notify()`, which sends `{schema, col, id, op}` on the channel `ai_changes`. The server listens once and streams the changed rows to the AI pages watching that business.
