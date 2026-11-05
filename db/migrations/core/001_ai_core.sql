-- core/001_ai_core.sql
-- Shared objects of the AI data server, in the CRM's public schema next to
-- businesses, users and sessions.
--
--   ai_api_keys  one row = one key the AI uses to reach the data of ONE business.
--                Only a SHA-256 hash of the secret is stored, like CRM sessions.
--   ai_notify()  trigger function: every change in an ai_* table (and in CRM
--                appointments) is sent on the channel "ai_changes", so the AI
--                sees changes live, also the ones made by the staff in the CRM.

CREATE TABLE IF NOT EXISTS public.ai_api_keys (
  key_id        VARCHAR(16)  PRIMARY KEY CHECK (key_id ~ '^[a-z0-9]{8,16}$'),
  business_id   UUID         NOT NULL REFERENCES public.businesses (business_id) ON DELETE CASCADE,
  secret_hash   CHAR(64)     NOT NULL,
  label         VARCHAR(80)  NOT NULL DEFAULT 'VoroniX AI',
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  last_used_at  TIMESTAMPTZ,
  revoked_at    TIMESTAMPTZ,
  CHECK (revoked_at IS NULL OR revoked_at >= created_at)
);
CREATE INDEX IF NOT EXISTS ai_api_keys_business_idx ON public.ai_api_keys (business_id);

-- TG_ARGV[0] = collection the AI knows ("clients", "bookings", ...)
-- TG_ARGV[1] = column that holds the collection's id
CREATE OR REPLACE FUNCTION public.ai_notify() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  rec jsonb := CASE WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
BEGIN
  PERFORM pg_notify('ai_changes', json_build_object(
    'schema', TG_TABLE_SCHEMA,
    'col',    TG_ARGV[0],
    'id',     rec ->> TG_ARGV[1],
    'op',     TG_OP,
    'table',  TG_TABLE_NAME
  )::text);
  RETURN NULL;
END;
$$;
