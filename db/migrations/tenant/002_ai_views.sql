-- tenant/002_ai_views.sql
-- Views that join the AI's data with the CRM. They are what the API reads, and
-- they can be opened in psql or in the CRM's read-only SQL console for reports.

-- Every visit in one calendar: bookings the AI made plus visits the staff
-- booked in the CRM (CRM visits the AI already knows are not repeated).
CREATE VIEW ai_calendar AS
SELECT b.id,
       b.client_id,
       b.client_name,
       b.service,
       b.staff,
       b.start_at,
       b.end_at,
       b.minutes,
       b.price,
       b.status,
       b.source,
       b.crm_appointment_id,
       a.status AS crm_status,
       b.created_at,
       'ai'::text AS origin
FROM ai_bookings b
LEFT JOIN appointments a ON a.appointment_id = b.crm_appointment_id
UNION ALL
SELECT a.appointment_id,
       coalesce(ac.id, a.client_id),
       c.display_name,
       a.service_code,
       a.master_id,
       a.start_at,
       a.end_at,
       (extract(epoch FROM a.end_at - a.start_at) / 60)::int,
       s.price_kzt,
       CASE WHEN a.status IN ('Cancelled', 'No-show') THEN 'cancelled' ELSE 'booked' END,
       'crm',
       a.appointment_id,
       a.status,
       a.created_at,
       'crm'::text
FROM appointments a
JOIN clients c  ON c.client_id = a.client_id
JOIN services s ON s.service_code = a.service_code
LEFT JOIN LATERAL (
  SELECT id FROM ai_clients WHERE crm_client_id = a.client_id ORDER BY last_seen DESC LIMIT 1
) ac ON TRUE
WHERE NOT EXISTS (SELECT 1 FROM ai_bookings b WHERE b.crm_appointment_id = a.appointment_id);

-- What the business taught the AI, from both places: files and texts fed to
-- the AI here, and entries typed on the CRM's "AI knowledge" page.
CREATE VIEW ai_knowledge_all AS
SELECT k.id, k.title, k.text, k.source, k.document_id, k.created_at, k.search, 'ai'::text AS origin
FROM ai_knowledge k
UNION ALL
SELECT e.entry_id, e.title, e.content, 'business', NULL, e.updated_at,
       setweight(to_tsvector('simple', e.title), 'A') || setweight(to_tsvector('simple', e.content), 'B'),
       'crm'
FROM knowledge_entries e;

-- One line per client for the CRM: who it is, what the AI learned, how it books.
CREATE VIEW ai_client_card AS
SELECT ac.id,
       ac.name,
       ac.channel,
       ac.handle,
       ac.lang,
       ac.crm_client_id,
       c.display_name AS crm_name,
       c.phone        AS crm_phone,
       ac.messages,
       ac.bookings,
       ac.cancels,
       ac.complaints,
       ac.mood,
       ac.last_seen,
       (SELECT p.value FROM ai_client_preferences p
         WHERE p.client_id = ac.id AND p.kind = 'service' ORDER BY p.weight DESC, p.value LIMIT 1) AS usual_service,
       (SELECT p.value FROM ai_client_preferences p
         WHERE p.client_id = ac.id AND p.kind = 'staff' ORDER BY p.weight DESC, p.value LIMIT 1)   AS usual_staff,
       (SELECT p.value FROM ai_client_preferences p
         WHERE p.client_id = ac.id AND p.kind = 'time' AND p.weight > 0 ORDER BY p.weight DESC, p.value LIMIT 1) AS usual_time,
       (SELECT string_agg(p.value, '; ' ORDER BY p.updated_at) FROM ai_client_preferences p
         WHERE p.client_id = ac.id AND p.kind = 'note') AS notes
FROM ai_clients ac
LEFT JOIN clients c ON c.client_id = ac.crm_client_id;

-- Training data in the same shape as data/phrases.tsv of the AI repository.
CREATE VIEW ai_training_set AS
SELECT lang, array_to_string(labels, ',') AS labels, text, source, learned_at
FROM ai_phrases
ORDER BY learned_at, id;
