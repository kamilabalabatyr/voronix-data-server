-- tenant/001_ai_tables.sql
-- The AI's own data, inside the CRM schema of each business (t_<id>), next to
-- clients, appointments and services. One business can never read another
-- one's AI data, exactly like the CRM tables.
--
-- Every table has typed columns for what we check and query, plus
-- extra JSONB for any field the AI adds later, so nothing the AI saves is lost.
--
--   ai_clients               one row = one client the AI talks to (its memory card)
--   ai_client_preferences    what each client prefers: service, barber, time, notes
--   ai_messages              full chat history of each client with the AI
--   ai_bookings              bookings the AI made; linked 1:1 to CRM appointments
--   ai_knowledge_documents   files and texts the business fed to the AI
--   ai_knowledge             knowledge entries (chunks) the AI searches when answering
--   ai_phrases               training data: phrases with the right intent labels
--   ai_review_queue          messages the AI wants a person to check
--   ai_model_versions        every trained model version and its test metrics
--   ai_events                log of what the AI did
--   ai_settings              key/value settings (business profile, retrain period)

-- ---------------------------------------------------------------- clients
CREATE TABLE ai_clients (
  id             VARCHAR(64)  PRIMARY KEY CHECK (id !~ '[[:space:]/\\?#%]'),
  crm_client_id  VARCHAR(12)  REFERENCES clients (client_id) ON DELETE SET NULL,
  name           VARCHAR(80)  NOT NULL CHECK (length(btrim(name)) > 0),
  channel        VARCHAR(10)  NOT NULL CHECK (channel IN ('instagram', 'telegram', 'whatsapp', 'crm')),
  handle         VARCHAR(100) NOT NULL DEFAULT '',
  lang           CHAR(2)      NOT NULL DEFAULT 'ru' CHECK (lang IN ('ru', 'kk', 'en')),
  first_seen     TIMESTAMPTZ  NOT NULL DEFAULT now(),
  last_seen      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  messages       INTEGER      NOT NULL DEFAULT 0 CHECK (messages >= 0),
  bookings       INTEGER      NOT NULL DEFAULT 0 CHECK (bookings >= 0),
  cancels        INTEGER      NOT NULL DEFAULT 0 CHECK (cancels >= 0),
  complaints     INTEGER      NOT NULL DEFAULT 0 CHECK (complaints >= 0),
  thanks         INTEGER      NOT NULL DEFAULT 0 CHECK (thanks >= 0),
  mood           NUMERIC(3,2) NOT NULL DEFAULT 0 CHECK (mood BETWEEN -1 AND 1),
  intents        JSONB        NOT NULL DEFAULT '{}'  CHECK (jsonb_typeof(intents) = 'object'),
  dialog         JSONB        NOT NULL DEFAULT '{"stage":"idle"}' CHECK (jsonb_typeof(dialog) = 'object'),
  extra          JSONB        NOT NULL DEFAULT '{}'  CHECK (jsonb_typeof(extra) = 'object'),
  updated_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CHECK (last_seen >= first_seen)
);
CREATE INDEX ai_clients_handle_idx ON ai_clients (channel, handle);
CREATE INDEX ai_clients_crm_idx ON ai_clients (crm_client_id);

-- One row per (client, kind, value). "learned" rows come from what the client
-- actually booked; "stated" (the client said it) and "staff" (an administrator
-- wrote it) are never overwritten by the AI.
CREATE TABLE ai_client_preferences (
  client_id   VARCHAR(64)  NOT NULL REFERENCES ai_clients (id) ON DELETE CASCADE,
  kind        VARCHAR(10)  NOT NULL CHECK (kind IN ('service', 'staff', 'time', 'language', 'note')),
  value       VARCHAR(200) NOT NULL CHECK (length(btrim(value)) > 0),
  weight      INTEGER      NOT NULL DEFAULT 1 CHECK (weight >= 0),
  source      VARCHAR(7)   NOT NULL DEFAULT 'learned' CHECK (source IN ('learned', 'stated', 'staff')),
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  PRIMARY KEY (client_id, kind, value),
  CHECK (kind <> 'time' OR value IN ('morning', 'day', 'evening'))
);

CREATE TABLE ai_messages (
  message_id  BIGSERIAL    PRIMARY KEY,
  client_id   VARCHAR(64)  NOT NULL REFERENCES ai_clients (id) ON DELETE CASCADE,
  sender      VARCHAR(6)   NOT NULL CHECK (sender IN ('client', 'ai', 'staff')),
  text        TEXT         NOT NULL CHECK (length(text) BETWEEN 1 AND 4000),
  labels      TEXT[],                            -- intents the AI read in a client message
  sent_at     TIMESTAMPTZ  NOT NULL
);
-- The AI re-sends the last 14 messages with every client save: the same
-- message is stored once.
CREATE UNIQUE INDEX ai_messages_once ON ai_messages (client_id, sent_at, sender, md5(text));
CREATE INDEX ai_messages_client_time_idx ON ai_messages (client_id, sent_at DESC);

-- ---------------------------------------------------------------- bookings
CREATE TABLE ai_bookings (
  id                  VARCHAR(64)   PRIMARY KEY CHECK (id !~ '[[:space:]/\\?#%]'),
  client_id           VARCHAR(64)   NOT NULL REFERENCES ai_clients (id) ON DELETE RESTRICT,
  client_name         VARCHAR(80)   NOT NULL DEFAULT '',
  service             VARCHAR(40)   NOT NULL,
  staff               VARCHAR(40)   NOT NULL,
  start_at            TIMESTAMP     NOT NULL,          -- business local time, like CRM appointments
  minutes             INTEGER       NOT NULL CHECK (minutes BETWEEN 5 AND 600),
  end_at              TIMESTAMP     GENERATED ALWAYS AS (start_at + minutes * INTERVAL '1 minute') STORED,
  price               NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (price >= 0),
  status              VARCHAR(10)   NOT NULL DEFAULT 'booked' CHECK (status IN ('booked', 'cancelled')),
  source              VARCHAR(10)   NOT NULL CHECK (source IN ('instagram', 'telegram', 'whatsapp', 'crm')),
  crm_appointment_id  VARCHAR(12)   UNIQUE REFERENCES appointments (appointment_id) ON DELETE SET NULL,
  sync_status         VARCHAR(7)    NOT NULL DEFAULT 'skipped' CHECK (sync_status IN ('synced', 'skipped', 'failed')),
  sync_error          TEXT,
  created_at          TIMESTAMPTZ   NOT NULL DEFAULT now(),
  extra               JSONB         NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(extra) = 'object'),
  CHECK (sync_status <> 'synced' OR crm_appointment_id IS NOT NULL),
  -- Same rule as CRM appointments: one master cannot have two visits at once.
  CONSTRAINT ai_bookings_no_overlap EXCLUDE USING gist (staff WITH =, tsrange(start_at, end_at) WITH &&)
    WHERE (status = 'booked')
);
CREATE INDEX ai_bookings_client_idx ON ai_bookings (client_id);
CREATE INDEX ai_bookings_start_idx ON ai_bookings (start_at);

-- ---------------------------------------------------------------- knowledge
CREATE TABLE ai_knowledge_documents (
  document_id  VARCHAR(64)   PRIMARY KEY CHECK (document_id !~ '[[:space:]/\\?#%]'),
  title        VARCHAR(200)  NOT NULL CHECK (length(btrim(title)) > 0),
  file_name    VARCHAR(200),
  mime         VARCHAR(100)  NOT NULL DEFAULT 'text/plain',
  content      TEXT          NOT NULL CHECK (length(content) BETWEEN 1 AND 2000000),
  size_bytes   INTEGER       GENERATED ALWAYS AS (octet_length(content)) STORED,
  source       VARCHAR(8)    NOT NULL DEFAULT 'business' CHECK (source IN ('business', 'operator', 'file')),
  uploaded_by  VARCHAR(80)   NOT NULL DEFAULT '',
  uploaded_at  TIMESTAMPTZ   NOT NULL DEFAULT now()
);

CREATE TABLE ai_knowledge (
  id           VARCHAR(64)   PRIMARY KEY CHECK (id !~ '[[:space:]/\\?#%]'),
  document_id  VARCHAR(64)   REFERENCES ai_knowledge_documents (document_id) ON DELETE CASCADE,
  title        VARCHAR(200)  NOT NULL CHECK (length(btrim(title)) > 0),
  text         TEXT          NOT NULL CHECK (length(text) BETWEEN 1 AND 60000),
  source       VARCHAR(8)    NOT NULL DEFAULT 'business' CHECK (source IN ('business', 'operator', 'file')),
  file         VARCHAR(200),
  tags         TEXT[]        NOT NULL DEFAULT '{}',
  created_at   TIMESTAMPTZ   NOT NULL DEFAULT now(),
  extra        JSONB         NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(extra) = 'object'),
  -- 'simple': no stemming, works the same for Russian, Kazakh and English;
  -- the search adds prefix matching (стрижк:*) instead.
  search       TSVECTOR      GENERATED ALWAYS AS (
                 setweight(to_tsvector('simple', coalesce(title, '')), 'A') ||
                 setweight(to_tsvector('simple', coalesce(text, '')), 'B')) STORED
);
CREATE INDEX ai_knowledge_search_idx ON ai_knowledge USING gin (search);
CREATE INDEX ai_knowledge_document_idx ON ai_knowledge (document_id);

-- ---------------------------------------------------------------- training
CREATE TABLE ai_phrases (
  id          VARCHAR(64)  PRIMARY KEY CHECK (id !~ '[[:space:]/\\?#%]'),
  text        TEXT         NOT NULL CHECK (length(btrim(text)) BETWEEN 1 AND 1000),
  lang        CHAR(2)      NOT NULL CHECK (lang IN ('ru', 'kk', 'en')),
  labels      TEXT[]       NOT NULL CHECK (
                cardinality(labels) >= 1 AND
                labels <@ ARRAY['greeting','price','booking','cancel','complaint','address','hours','confirm','thanks','other']::text[]),
  source      VARCHAR(8)   NOT NULL CHECK (source IN ('client', 'operator', 'business', 'auto')),
  why         TEXT         NOT NULL DEFAULT '',
  client_id   VARCHAR(64),                       -- no FK: a phrase outlives the client card
  learned_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  extra       JSONB        NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(extra) = 'object')
);
CREATE INDEX ai_phrases_learned_idx ON ai_phrases (learned_at, id);

CREATE TABLE ai_review_queue (
  id           VARCHAR(64)  PRIMARY KEY CHECK (id !~ '[[:space:]/\\?#%]'),
  kind         VARCHAR(10)  NOT NULL CHECK (kind IN ('unsure', 'unanswered', 'complaint')),
  text         TEXT         NOT NULL CHECK (length(text) BETWEEN 1 AND 4000),
  lang         CHAR(2)      NOT NULL CHECK (lang IN ('ru', 'kk', 'en')),
  guess        TEXT[]       NOT NULL DEFAULT '{}',
  score        NUMERIC(6,4) NOT NULL DEFAULT 0,
  client_id    VARCHAR(64),
  client_name  VARCHAR(80),
  channel      VARCHAR(10)  CHECK (channel IN ('instagram', 'telegram', 'whatsapp')),
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  extra        JSONB        NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(extra) = 'object')
);
CREATE INDEX ai_review_queue_created_idx ON ai_review_queue (created_at);

CREATE TABLE ai_model_versions (
  id          VARCHAR(64)  PRIMARY KEY CHECK (id !~ '[[:space:]/\\?#%]'),
  n           INTEGER      NOT NULL UNIQUE CHECK (n >= 0),
  status      VARCHAR(8)   NOT NULL CHECK (status IN ('live', 'old', 'rejected')),
  trained_on  INTEGER      NOT NULL DEFAULT 0 CHECK (trained_on >= 0),   -- number of phrases
  metrics     JSONB        NOT NULL CHECK (jsonb_typeof(metrics) = 'object'),
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  extra       JSONB        NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(extra) = 'object')
);
-- Only one model version can be live at a time.
CREATE UNIQUE INDEX ai_model_versions_one_live ON ai_model_versions ((status)) WHERE status = 'live';

CREATE TABLE ai_events (
  id          VARCHAR(64)  PRIMARY KEY CHECK (id !~ '[[:space:]/\\?#%]'),
  kind        VARCHAR(10)  NOT NULL CHECK (kind IN ('message', 'learn', 'retrain', 'knowledge', 'review', 'command', 'business')),
  title       TEXT         NOT NULL,
  detail      JSONB,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX ai_events_created_idx ON ai_events (created_at);

CREATE TABLE ai_settings (
  id          VARCHAR(40)  PRIMARY KEY CHECK (id !~ '[[:space:]/\\?#%]'),
  value       JSONB        NOT NULL CHECK (jsonb_typeof(value) = 'object'),
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- live changes
CREATE TRIGGER ai_clients_notify     AFTER INSERT OR UPDATE OR DELETE ON ai_clients            FOR EACH ROW EXECUTE FUNCTION public.ai_notify('clients', 'id');
CREATE TRIGGER ai_prefs_notify       AFTER INSERT OR UPDATE OR DELETE ON ai_client_preferences FOR EACH ROW EXECUTE FUNCTION public.ai_notify('clients', 'client_id');
CREATE TRIGGER ai_bookings_notify    AFTER INSERT OR UPDATE OR DELETE ON ai_bookings           FOR EACH ROW EXECUTE FUNCTION public.ai_notify('bookings', 'id');
CREATE TRIGGER ai_knowledge_notify   AFTER INSERT OR UPDATE OR DELETE ON ai_knowledge          FOR EACH ROW EXECUTE FUNCTION public.ai_notify('knowledge', 'id');
CREATE TRIGGER ai_phrases_notify     AFTER INSERT OR UPDATE OR DELETE ON ai_phrases            FOR EACH ROW EXECUTE FUNCTION public.ai_notify('phrases', 'id');
CREATE TRIGGER ai_queue_notify       AFTER INSERT OR UPDATE OR DELETE ON ai_review_queue       FOR EACH ROW EXECUTE FUNCTION public.ai_notify('queue', 'id');
CREATE TRIGGER ai_versions_notify    AFTER INSERT OR UPDATE OR DELETE ON ai_model_versions     FOR EACH ROW EXECUTE FUNCTION public.ai_notify('versions', 'id');
CREATE TRIGGER ai_events_notify      AFTER INSERT OR UPDATE OR DELETE ON ai_events             FOR EACH ROW EXECUTE FUNCTION public.ai_notify('events', 'id');
CREATE TRIGGER ai_settings_notify    AFTER INSERT OR UPDATE OR DELETE ON ai_settings           FOR EACH ROW EXECUTE FUNCTION public.ai_notify('settings', 'id');
-- A visit booked, moved or cancelled by the staff in the CRM reaches the AI too.
CREATE TRIGGER ai_appointments_notify AFTER INSERT OR UPDATE OR DELETE ON appointments         FOR EACH ROW EXECUTE FUNCTION public.ai_notify('bookings', 'appointment_id');
