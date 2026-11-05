-- tenant/004_one_client_many_messengers.sql
-- One real person = one CRM client, whichever messenger they write from.
--
-- An AI client (ai_clients) is one messenger account: Instagram @aliya,
-- WhatsApp +7 700 123 45 67, Telegram aliya_tg. Several of them point to the
-- same CRM client (crm_client_id), the same way client_channels does in the CRM.
--   * the same phone number      → linked automatically (phone is unique in the CRM)
--   * only the same name         → listed in ai_duplicate_candidates for a person to decide
--   * a person said "not the same" → ai_distinct_clients, never suggested again

-- '+7 (700) 123-45-67', '8 700 123 4567', '7001234567' → '+77001234567'
CREATE OR REPLACE FUNCTION ai_norm_phone(p text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
           WHEN d ~ '^8[0-9]{10}$' THEN '+7' || substr(d, 2)
           WHEN d ~ '^[0-9]{10}$'  THEN '+7' || d
           WHEN d ~ '^[0-9]{11,15}$' THEN '+' || d
         END
  FROM (SELECT regexp_replace(coalesce(p, ''), '[^0-9]', '', 'g') AS d) x
$$;

ALTER TABLE ai_clients ADD COLUMN phone VARCHAR(16)
  CHECK (phone IS NULL OR phone ~ '^\+[0-9]{10,15}$');
CREATE INDEX ai_clients_phone_idx ON ai_clients (phone);

-- Finds CRM clients by phone however the phone was typed in the CRM.
CREATE INDEX IF NOT EXISTS clients_norm_phone_idx ON clients (ai_norm_phone(phone));

-- Pairs a person checked and said are different people.
CREATE TABLE ai_distinct_clients (
  client_a    VARCHAR(64)  NOT NULL REFERENCES ai_clients (id) ON DELETE CASCADE,
  client_b    VARCHAR(64)  NOT NULL REFERENCES ai_clients (id) ON DELETE CASCADE,
  decided_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  PRIMARY KEY (client_a, client_b),
  CHECK (client_a < client_b)
);

-- Probably the same person: same first name, different messengers, not yet one
-- CRM client, and nobody said they are different.
CREATE VIEW ai_duplicate_candidates AS
SELECT a.id AS client_a, b.id AS client_b,
       a.name AS name_a, b.name AS name_b,
       a.channel AS channel_a, b.channel AS channel_b,
       'same name'::text AS reason
FROM ai_clients a
JOIN ai_clients b
  ON a.id < b.id
 AND a.channel <> b.channel
 AND lower(split_part(btrim(a.name), ' ', 1)) = lower(split_part(btrim(b.name), ' ', 1))
WHERE (a.crm_client_id IS NULL OR b.crm_client_id IS NULL OR a.crm_client_id <> b.crm_client_id)
  AND NOT EXISTS (SELECT 1 FROM ai_distinct_clients d WHERE d.client_a = a.id AND d.client_b = b.id);
