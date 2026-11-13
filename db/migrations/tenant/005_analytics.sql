-- tenant/005_analytics.sql
-- Business analytics on top of the CRM and the AI's data: read-only views the
-- dashboard (/dashboard) and the CRM's SQL console use. Nothing is copied, so the
-- numbers are always current.
--
--   analytics_services   which services sell, what they earn, how often they are cancelled
--   analytics_masters    each master's visits, revenue and no-show rate
--   analytics_channels   where bookings come from: Telegram, WhatsApp, Instagram, the admin
--   analytics_weekdays   busy days and the days clients do not come
--   analytics_months     visits and revenue month by month
--   analytics_funnel     chats per messenger and how many of them became a booking
--   analytics_ai_quality how the AI model improved from version to version
--
-- Revenue counts completed visits at the service's price list price.

CREATE VIEW analytics_services AS
SELECT s.service_code                                                     AS service,
       s.name,
       s.price_kzt                                                        AS price,
       count(a.*)                                                         AS bookings,
       count(a.*) FILTER (WHERE a.status = 'Completed')                   AS completed,
       count(a.*) FILTER (WHERE a.status IN ('Cancelled', 'No-show'))     AS lost,
       coalesce(sum(s.price_kzt) FILTER (WHERE a.status = 'Completed'), 0) AS revenue
FROM services s
LEFT JOIN appointments a ON a.service_code = s.service_code
GROUP BY s.service_code, s.name, s.price_kzt;

CREATE VIEW analytics_masters AS
SELECT m.master_id                                                        AS master,
       m.full_name                                                        AS name,
       count(a.*) FILTER (WHERE a.status = 'Completed')                   AS completed,
       count(a.*) FILTER (WHERE a.status = 'No-show')                     AS no_show,
       round(100.0 * count(a.*) FILTER (WHERE a.status = 'No-show')
             / nullif(count(a.*) FILTER (WHERE a.status IN ('Completed', 'No-show')), 0), 1) AS no_show_pct,
       coalesce(sum(s.price_kzt) FILTER (WHERE a.status = 'Completed'), 0) AS revenue
FROM masters m
LEFT JOIN appointments a ON a.master_id = m.master_id
LEFT JOIN services s ON s.service_code = a.service_code
GROUP BY m.master_id, m.full_name;

CREATE VIEW analytics_channels AS
SELECT a.source                                                           AS channel,
       count(*)                                                           AS bookings,
       count(*) FILTER (WHERE a.status = 'Completed')                     AS completed,
       round(100.0 * count(*) FILTER (WHERE a.status IN ('Cancelled', 'No-show')) / count(*), 1) AS lost_pct,
       coalesce(sum(s.price_kzt) FILTER (WHERE a.status = 'Completed'), 0) AS revenue
FROM appointments a
JOIN services s ON s.service_code = a.service_code
GROUP BY a.source;

-- 1 = Monday ... 7 = Sunday
CREATE VIEW analytics_weekdays AS
SELECT extract(isodow FROM a.start_at)::int                               AS weekday,
       count(*)                                                           AS bookings,
       count(*) FILTER (WHERE a.status = 'Completed')                     AS completed,
       round(100.0 * count(*) FILTER (WHERE a.status IN ('Cancelled', 'No-show')) / count(*), 1) AS lost_pct
FROM appointments a
GROUP BY 1;

CREATE VIEW analytics_months AS
SELECT to_char(date_trunc('month', a.start_at), 'YYYY-MM')                AS month,
       count(*) FILTER (WHERE a.status = 'Completed')                     AS completed,
       coalesce(sum(s.price_kzt) FILTER (WHERE a.status = 'Completed'), 0) AS revenue,
       count(DISTINCT a.client_id)                                        AS clients
FROM appointments a
JOIN services s ON s.service_code = a.service_code
GROUP BY 1;

-- A chat "became a booking" when it is linked to a visit or reached Booked/Paid/Visited.
CREATE VIEW analytics_funnel AS
SELECT c.messenger                                                        AS channel,
       count(*)                                                           AS chats,
       count(*) FILTER (WHERE c.appointment_id IS NOT NULL OR c.stage IN ('Booked', 'Paid', 'Visited')) AS booked,
       count(*) FILTER (WHERE c.needs_human)                              AS handed_to_human,
       round(100.0 * count(*) FILTER (WHERE c.appointment_id IS NOT NULL OR c.stage IN ('Booked', 'Paid', 'Visited')) / count(*), 1) AS conversion_pct
FROM conversations c
GROUP BY c.messenger;

CREATE VIEW analytics_ai_quality AS
SELECT v.n                                                                AS version,
       v.created_at,
       v.status,
       v.trained_on                                                       AS phrases,
       (v.metrics ->> 'exact')::numeric                                   AS exact,
       (v.metrics ->> 'f1')::numeric                                      AS f1
FROM ai_model_versions v;
