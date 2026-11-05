SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;
CREATE SCHEMA __SCHEMA__;
CREATE FUNCTION __SCHEMA__.appointments_result_after_visit() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.status IN ('Completed', 'No-show') AND NEW.start_at > LOCALTIMESTAMP THEN
    RAISE EXCEPTION 'Visit % has not started yet, so it cannot be %', NEW.appointment_id, NEW.status
      USING ERRCODE = '23514', CONSTRAINT = 'appointments_result_after_visit';
  END IF;
  RETURN NEW;
END
$$;
SET default_tablespace = '';
SET default_table_access_method = heap;
CREATE TABLE __SCHEMA__.ai_runs (
    run_id bigint NOT NULL,
    conversation_id character varying(12),
    engine character varying(40) NOT NULL,
    latency_ms integer NOT NULL,
    tool_calls jsonb DEFAULT '[]'::jsonb NOT NULL,
    input_tokens integer,
    output_tokens integer,
    outcome character varying(12) NOT NULL,
    error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ai_runs_latency_ms_check CHECK ((latency_ms >= 0)),
    CONSTRAINT ai_runs_outcome_check CHECK (((outcome)::text = ANY ((ARRAY['replied'::character varying, 'handoff'::character varying, 'error'::character varying, 'cancelled'::character varying])::text[])))
);
CREATE SEQUENCE __SCHEMA__.ai_runs_run_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE __SCHEMA__.ai_runs_run_id_seq OWNED BY __SCHEMA__.ai_runs.run_id;
CREATE TABLE __SCHEMA__.appointment_reminders (
    appointment_id character varying(12) NOT NULL,
    kind character varying(3) NOT NULL,
    conversation_id character varying(12),
    outcome character varying(10) NOT NULL,
    note text DEFAULT ''::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT appointment_reminders_kind_check CHECK (((kind)::text = ANY ((ARRAY['24h'::character varying, '2h'::character varying])::text[]))),
    CONSTRAINT appointment_reminders_outcome_check CHECK (((outcome)::text = ANY ((ARRAY['sent'::character varying, 'skipped'::character varying])::text[])))
);
CREATE TABLE __SCHEMA__.appointments (
    appointment_id character varying(12) NOT NULL,
    client_id character varying(12) NOT NULL,
    master_id character varying(8) NOT NULL,
    service_code character(5) NOT NULL,
    start_at timestamp without time zone NOT NULL,
    end_at timestamp without time zone NOT NULL,
    status character varying(10) DEFAULT 'Booked'::character varying NOT NULL,
    source character varying(10) DEFAULT 'Admin'::character varying NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT appointments_check CHECK ((end_at > start_at)),
    CONSTRAINT appointments_source_check CHECK (((source)::text = ANY ((ARRAY['Telegram'::character varying, 'WhatsApp'::character varying, 'Instagram'::character varying, 'Admin'::character varying])::text[]))),
    CONSTRAINT appointments_status_check CHECK (((status)::text = ANY ((ARRAY['Booked'::character varying, 'Confirmed'::character varying, 'Completed'::character varying, 'Cancelled'::character varying, 'No-show'::character varying])::text[])))
);
CREATE SEQUENCE __SCHEMA__.appointments_seq
    START WITH 1001
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE __SCHEMA__.appointments_seq OWNED BY __SCHEMA__.appointments.appointment_id;
CREATE TABLE __SCHEMA__.business_settings (
    id smallint DEFAULT 1 NOT NULL,
    name character varying(80) NOT NULL,
    business_type character varying(60) DEFAULT 'Beauty salon'::character varying NOT NULL,
    city character varying(60) DEFAULT ''::character varying NOT NULL,
    address character varying(160) DEFAULT ''::character varying NOT NULL,
    hours character varying(120) DEFAULT ''::character varying NOT NULL,
    phone character varying(40) DEFAULT ''::character varying NOT NULL,
    tone text DEFAULT ''::text NOT NULL,
    languages character varying(120) DEFAULT ''::character varying NOT NULL,
    staff_label character varying(30) DEFAULT 'Master'::character varying NOT NULL,
    service_label character varying(30) DEFAULT 'Service'::character varying NOT NULL,
    prepay_percent smallint DEFAULT 30 NOT NULL,
    prepay_min_price_kzt integer DEFAULT 20000 NOT NULL,
    autopilot boolean DEFAULT true NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    catchphrase character varying(200) DEFAULT ''::character varying NOT NULL,
    CONSTRAINT business_settings_id_check CHECK ((id = 1)),
    CONSTRAINT business_settings_prepay_min_price_kzt_check CHECK ((prepay_min_price_kzt >= 0)),
    CONSTRAINT business_settings_prepay_percent_check CHECK (((prepay_percent >= 0) AND (prepay_percent <= 100)))
);
CREATE TABLE __SCHEMA__.client_channels (
    channel_id character varying(12) NOT NULL,
    client_id character varying(12) NOT NULL,
    messenger character varying(10) NOT NULL,
    external_user_id character varying(64) NOT NULL,
    CONSTRAINT client_channels_messenger_check CHECK (((messenger)::text = ANY ((ARRAY['Telegram'::character varying, 'WhatsApp'::character varying, 'Instagram'::character varying])::text[])))
);
CREATE SEQUENCE __SCHEMA__.client_channels_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE __SCHEMA__.client_channels_seq OWNED BY __SCHEMA__.client_channels.channel_id;
CREATE TABLE __SCHEMA__.clients (
    client_id character varying(12) NOT NULL,
    display_name character varying(50) NOT NULL,
    phone character varying(20),
    notes text DEFAULT ''::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT clients_client_id_check CHECK (((client_id)::text ~ '^CL-[0-9]{4,}$'::text)),
    CONSTRAINT clients_display_name_check CHECK ((length(btrim((display_name)::text)) > 0))
);
CREATE SEQUENCE __SCHEMA__.clients_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE __SCHEMA__.clients_seq OWNED BY __SCHEMA__.clients.client_id;
CREATE TABLE __SCHEMA__.conversations (
    conversation_id character varying(12) NOT NULL,
    messenger character varying(10) NOT NULL,
    external_user_id character varying(64) NOT NULL,
    contact_name character varying(60) NOT NULL,
    client_id character varying(12),
    appointment_id character varying(12),
    stage character varying(10) DEFAULT 'New'::character varying NOT NULL,
    ai_enabled boolean DEFAULT true NOT NULL,
    needs_human boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT conversations_messenger_check CHECK (((messenger)::text = ANY ((ARRAY['Telegram'::character varying, 'WhatsApp'::character varying, 'Instagram'::character varying])::text[]))),
    CONSTRAINT conversations_stage_check CHECK (((stage)::text = ANY ((ARRAY['New'::character varying, 'In dialog'::character varying, 'Booked'::character varying, 'Paid'::character varying, 'Visited'::character varying, 'Lost'::character varying])::text[])))
);
CREATE SEQUENCE __SCHEMA__.conversations_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE __SCHEMA__.conversations_seq OWNED BY __SCHEMA__.conversations.conversation_id;
CREATE TABLE __SCHEMA__.integrations (
    provider character varying(20) NOT NULL,
    enabled boolean DEFAULT false NOT NULL,
    settings jsonb DEFAULT '{}'::jsonb NOT NULL,
    secret text,
    status character varying(10) DEFAULT 'off'::character varying NOT NULL,
    status_detail character varying(300) DEFAULT ''::character varying NOT NULL,
    checked_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT integrations_provider_check CHECK (((provider)::text = ANY ((ARRAY['telegram'::character varying, 'whatsapp'::character varying, 'instagram'::character varying, 'claude'::character varying, 'kaspi'::character varying, 'google_calendar'::character varying, 'webhook'::character varying])::text[]))),
    CONSTRAINT integrations_status_check CHECK (((status)::text = ANY ((ARRAY['off'::character varying, 'connected'::character varying, 'error'::character varying])::text[])))
);
CREATE TABLE __SCHEMA__.knowledge_entries (
    entry_id character varying(12) NOT NULL,
    title character varying(120) NOT NULL,
    category character varying(40) DEFAULT 'General'::character varying NOT NULL,
    content text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT knowledge_entries_content_check CHECK (((length(content) >= 1) AND (length(content) <= 60000))),
    CONSTRAINT knowledge_entries_title_check CHECK ((length(btrim((title)::text)) > 0))
);
CREATE SEQUENCE __SCHEMA__.knowledge_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE __SCHEMA__.knowledge_seq OWNED BY __SCHEMA__.knowledge_entries.entry_id;
CREATE TABLE __SCHEMA__.master_accounts (
    account_id integer NOT NULL,
    master_id character varying(8) NOT NULL,
    login character varying(30) NOT NULL,
    password_hash character varying(255) NOT NULL,
    last_login timestamp with time zone
);
CREATE SEQUENCE __SCHEMA__.master_accounts_account_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE __SCHEMA__.master_accounts_account_id_seq OWNED BY __SCHEMA__.master_accounts.account_id;
CREATE TABLE __SCHEMA__.master_services (
    master_id character varying(8) NOT NULL,
    service_code character(5) NOT NULL,
    skill_level character varying(10) DEFAULT 'Senior'::character varying NOT NULL,
    since_date date DEFAULT CURRENT_DATE NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    CONSTRAINT master_services_skill_level_check CHECK (((skill_level)::text = ANY ((ARRAY['Junior'::character varying, 'Senior'::character varying])::text[])))
);
CREATE TABLE __SCHEMA__.masters (
    master_id character varying(8) NOT NULL,
    full_name character varying(60) NOT NULL,
    specialization character varying(40) DEFAULT ''::character varying NOT NULL,
    work_start time without time zone DEFAULT '09:00:00'::time without time zone NOT NULL,
    work_end time without time zone DEFAULT '20:00:00'::time without time zone NOT NULL,
    work_days smallint[] DEFAULT '{1,2,3,4,5,6}'::smallint[] NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    CONSTRAINT masters_check CHECK ((work_end > work_start)),
    CONSTRAINT masters_full_name_check CHECK ((length(btrim((full_name)::text)) > 0)),
    CONSTRAINT masters_master_id_check CHECK (((master_id)::text ~ '^MS-[0-9]{2,}$'::text)),
    CONSTRAINT masters_work_days_check CHECK ((work_days <@ ARRAY[(0)::smallint, (1)::smallint, (2)::smallint, (3)::smallint, (4)::smallint, (5)::smallint, (6)::smallint]))
);
CREATE SEQUENCE __SCHEMA__.masters_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE __SCHEMA__.masters_seq OWNED BY __SCHEMA__.masters.master_id;
CREATE TABLE __SCHEMA__.messages (
    message_id bigint NOT NULL,
    conversation_id character varying(12) NOT NULL,
    sender character varying(6) NOT NULL,
    body text DEFAULT ''::text NOT NULL,
    payment_id character varying(12),
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT messages_check CHECK ((((sender)::text <> 'pay'::text) OR (payment_id IS NOT NULL))),
    CONSTRAINT messages_sender_check CHECK (((sender)::text = ANY ((ARRAY['client'::character varying, 'ai'::character varying, 'admin'::character varying, 'system'::character varying, 'pay'::character varying])::text[])))
);
CREATE SEQUENCE __SCHEMA__.messages_message_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE __SCHEMA__.messages_message_id_seq OWNED BY __SCHEMA__.messages.message_id;
CREATE TABLE __SCHEMA__.payments (
    payment_id character varying(12) NOT NULL,
    appointment_id character varying(12) NOT NULL,
    amount_kzt integer NOT NULL,
    kind character varying(10) NOT NULL,
    method character varying(10) DEFAULT 'Kaspi QR'::character varying NOT NULL,
    status character varying(10) DEFAULT 'Pending'::character varying NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    paid_at timestamp with time zone,
    CONSTRAINT payments_amount_kzt_check CHECK ((amount_kzt > 0)),
    CONSTRAINT payments_check CHECK ((((status)::text = 'Pending'::text) OR (paid_at IS NOT NULL))),
    CONSTRAINT payments_kind_check CHECK (((kind)::text = ANY ((ARRAY['prepayment'::character varying, 'full'::character varying])::text[]))),
    CONSTRAINT payments_method_check CHECK (((method)::text = ANY ((ARRAY['Kaspi QR'::character varying, 'Card'::character varying, 'Cash'::character varying])::text[]))),
    CONSTRAINT payments_status_check CHECK (((status)::text = ANY ((ARRAY['Pending'::character varying, 'Paid'::character varying, 'Refunded'::character varying])::text[])))
);
CREATE SEQUENCE __SCHEMA__.payments_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE __SCHEMA__.payments_seq OWNED BY __SCHEMA__.payments.payment_id;
CREATE TABLE __SCHEMA__.services (
    service_code character(5) NOT NULL,
    name character varying(50) NOT NULL,
    category character varying(30) DEFAULT ''::character varying NOT NULL,
    duration_min integer NOT NULL,
    price_kzt integer NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    CONSTRAINT services_duration_min_check CHECK (((duration_min >= 15) AND (duration_min <= 240))),
    CONSTRAINT services_price_kzt_check CHECK ((price_kzt > 0)),
    CONSTRAINT services_service_code_check CHECK ((service_code ~ '^[A-Z]{2}-[0-9]{2}$'::text))
);
CREATE TABLE __SCHEMA__.tenant_migrations (
    version character varying(100) NOT NULL,
    applied_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE VIEW __SCHEMA__.v_daily_revenue AS
 SELECT (a.start_at)::date AS day,
    count(*) AS completed_visits,
    sum(s.price_kzt) AS revenue_kzt
   FROM (__SCHEMA__.appointments a
     JOIN __SCHEMA__.services s ON ((s.service_code = a.service_code)))
  WHERE ((a.status)::text = 'Completed'::text)
  GROUP BY ((a.start_at)::date);
CREATE VIEW __SCHEMA__.v_no_show_by_service AS
 SELECT s.service_code,
    s.name AS service,
    (date_trunc('month'::text, a.start_at))::date AS month,
    count(*) AS finished_visits,
    count(*) FILTER (WHERE ((a.status)::text = 'No-show'::text)) AS no_shows,
    round(((100.0 * (count(*) FILTER (WHERE ((a.status)::text = 'No-show'::text)))::numeric) / (count(*))::numeric), 1) AS no_show_pct,
    (count(*) FILTER (WHERE ((a.status)::text = 'No-show'::text)) * s.price_kzt) AS lost_revenue_kzt
   FROM (__SCHEMA__.appointments a
     JOIN __SCHEMA__.services s ON ((s.service_code = a.service_code)))
  WHERE ((a.status)::text = ANY ((ARRAY['Completed'::character varying, 'No-show'::character varying])::text[]))
  GROUP BY s.service_code, s.name, s.price_kzt, (date_trunc('month'::text, a.start_at));
CREATE VIEW __SCHEMA__.v_visits_to_close AS
 SELECT a.appointment_id,
    a.start_at,
    c.display_name AS client,
    s.name AS service,
    m.full_name AS master,
    a.status,
    (floor((EXTRACT(epoch FROM (LOCALTIMESTAMP - a.end_at)) / (3600)::numeric)))::integer AS hours_overdue
   FROM (((__SCHEMA__.appointments a
     JOIN __SCHEMA__.clients c ON (((c.client_id)::text = (a.client_id)::text)))
     JOIN __SCHEMA__.services s ON ((s.service_code = a.service_code)))
     JOIN __SCHEMA__.masters m ON (((m.master_id)::text = (a.master_id)::text)))
  WHERE (((a.status)::text = ANY ((ARRAY['Booked'::character varying, 'Confirmed'::character varying])::text[])) AND (a.end_at < LOCALTIMESTAMP));
ALTER TABLE ONLY __SCHEMA__.ai_runs ALTER COLUMN run_id SET DEFAULT nextval('__SCHEMA__.ai_runs_run_id_seq'::regclass);
ALTER TABLE ONLY __SCHEMA__.appointments ALTER COLUMN appointment_id SET DEFAULT ('AP-'::text || (nextval('__SCHEMA__.appointments_seq'::regclass))::text);
ALTER TABLE ONLY __SCHEMA__.client_channels ALTER COLUMN channel_id SET DEFAULT ('CH-'::text || lpad((nextval('__SCHEMA__.client_channels_seq'::regclass))::text, 4, '0'::text));
ALTER TABLE ONLY __SCHEMA__.clients ALTER COLUMN client_id SET DEFAULT ('CL-'::text || lpad((nextval('__SCHEMA__.clients_seq'::regclass))::text, 4, '0'::text));
ALTER TABLE ONLY __SCHEMA__.conversations ALTER COLUMN conversation_id SET DEFAULT ('CV-'::text || lpad((nextval('__SCHEMA__.conversations_seq'::regclass))::text, 4, '0'::text));
ALTER TABLE ONLY __SCHEMA__.knowledge_entries ALTER COLUMN entry_id SET DEFAULT ('KB-'::text || (nextval('__SCHEMA__.knowledge_seq'::regclass))::text);
ALTER TABLE ONLY __SCHEMA__.master_accounts ALTER COLUMN account_id SET DEFAULT nextval('__SCHEMA__.master_accounts_account_id_seq'::regclass);
ALTER TABLE ONLY __SCHEMA__.masters ALTER COLUMN master_id SET DEFAULT ('MS-'::text || lpad((nextval('__SCHEMA__.masters_seq'::regclass))::text, 2, '0'::text));
ALTER TABLE ONLY __SCHEMA__.messages ALTER COLUMN message_id SET DEFAULT nextval('__SCHEMA__.messages_message_id_seq'::regclass);
ALTER TABLE ONLY __SCHEMA__.payments ALTER COLUMN payment_id SET DEFAULT ('PM-'::text || lpad((nextval('__SCHEMA__.payments_seq'::regclass))::text, 5, '0'::text));
ALTER TABLE ONLY __SCHEMA__.ai_runs
    ADD CONSTRAINT ai_runs_pkey PRIMARY KEY (run_id);
ALTER TABLE ONLY __SCHEMA__.appointment_reminders
    ADD CONSTRAINT appointment_reminders_pkey PRIMARY KEY (appointment_id, kind);
ALTER TABLE ONLY __SCHEMA__.appointments
    ADD CONSTRAINT appointments_no_overlap EXCLUDE USING gist (master_id WITH =, tsrange(start_at, end_at) WITH &&) WHERE (((status)::text <> 'Cancelled'::text));
ALTER TABLE ONLY __SCHEMA__.appointments
    ADD CONSTRAINT appointments_pkey PRIMARY KEY (appointment_id);
ALTER TABLE ONLY __SCHEMA__.business_settings
    ADD CONSTRAINT business_settings_pkey PRIMARY KEY (id);
ALTER TABLE ONLY __SCHEMA__.client_channels
    ADD CONSTRAINT client_channels_messenger_external_user_id_key UNIQUE (messenger, external_user_id);
ALTER TABLE ONLY __SCHEMA__.client_channels
    ADD CONSTRAINT client_channels_pkey PRIMARY KEY (channel_id);
ALTER TABLE ONLY __SCHEMA__.clients
    ADD CONSTRAINT clients_phone_key UNIQUE (phone);
ALTER TABLE ONLY __SCHEMA__.clients
    ADD CONSTRAINT clients_pkey PRIMARY KEY (client_id);
ALTER TABLE ONLY __SCHEMA__.conversations
    ADD CONSTRAINT conversations_messenger_external_user_id_key UNIQUE (messenger, external_user_id);
ALTER TABLE ONLY __SCHEMA__.conversations
    ADD CONSTRAINT conversations_pkey PRIMARY KEY (conversation_id);
ALTER TABLE ONLY __SCHEMA__.integrations
    ADD CONSTRAINT integrations_pkey PRIMARY KEY (provider);
ALTER TABLE ONLY __SCHEMA__.knowledge_entries
    ADD CONSTRAINT knowledge_entries_pkey PRIMARY KEY (entry_id);
ALTER TABLE ONLY __SCHEMA__.master_accounts
    ADD CONSTRAINT master_accounts_login_key UNIQUE (login);
ALTER TABLE ONLY __SCHEMA__.master_accounts
    ADD CONSTRAINT master_accounts_master_id_key UNIQUE (master_id);
ALTER TABLE ONLY __SCHEMA__.master_accounts
    ADD CONSTRAINT master_accounts_pkey PRIMARY KEY (account_id);
ALTER TABLE ONLY __SCHEMA__.master_services
    ADD CONSTRAINT master_services_pkey PRIMARY KEY (master_id, service_code);
ALTER TABLE ONLY __SCHEMA__.masters
    ADD CONSTRAINT masters_pkey PRIMARY KEY (master_id);
ALTER TABLE ONLY __SCHEMA__.messages
    ADD CONSTRAINT messages_pkey PRIMARY KEY (message_id);
ALTER TABLE ONLY __SCHEMA__.payments
    ADD CONSTRAINT payments_pkey PRIMARY KEY (payment_id);
ALTER TABLE ONLY __SCHEMA__.services
    ADD CONSTRAINT services_name_key UNIQUE (name);
ALTER TABLE ONLY __SCHEMA__.services
    ADD CONSTRAINT services_pkey PRIMARY KEY (service_code);
ALTER TABLE ONLY __SCHEMA__.tenant_migrations
    ADD CONSTRAINT tenant_migrations_pkey PRIMARY KEY (version);
CREATE INDEX ai_runs_created_idx ON __SCHEMA__.ai_runs USING btree (created_at);
CREATE INDEX appointments_client_idx ON __SCHEMA__.appointments USING btree (client_id);
CREATE INDEX appointments_service_status_idx ON __SCHEMA__.appointments USING btree (service_code, status);
CREATE INDEX appointments_start_idx ON __SCHEMA__.appointments USING btree (start_at);
CREATE INDEX client_channels_client_idx ON __SCHEMA__.client_channels USING btree (client_id);
CREATE INDEX messages_conversation_idx ON __SCHEMA__.messages USING btree (conversation_id, message_id);
CREATE INDEX payments_appointment_idx ON __SCHEMA__.payments USING btree (appointment_id);
CREATE TRIGGER appointments_result_after_visit BEFORE INSERT OR UPDATE OF status, start_at ON __SCHEMA__.appointments FOR EACH ROW EXECUTE FUNCTION __SCHEMA__.appointments_result_after_visit();
ALTER TABLE ONLY __SCHEMA__.ai_runs
    ADD CONSTRAINT ai_runs_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES __SCHEMA__.conversations(conversation_id) ON DELETE CASCADE;
ALTER TABLE ONLY __SCHEMA__.appointment_reminders
    ADD CONSTRAINT appointment_reminders_appointment_id_fkey FOREIGN KEY (appointment_id) REFERENCES __SCHEMA__.appointments(appointment_id) ON DELETE CASCADE;
ALTER TABLE ONLY __SCHEMA__.appointment_reminders
    ADD CONSTRAINT appointment_reminders_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES __SCHEMA__.conversations(conversation_id) ON DELETE SET NULL;
ALTER TABLE ONLY __SCHEMA__.appointments
    ADD CONSTRAINT appointments_client_id_fkey FOREIGN KEY (client_id) REFERENCES __SCHEMA__.clients(client_id) ON DELETE RESTRICT;
ALTER TABLE ONLY __SCHEMA__.appointments
    ADD CONSTRAINT appointments_master_id_service_code_fkey FOREIGN KEY (master_id, service_code) REFERENCES __SCHEMA__.master_services(master_id, service_code);
ALTER TABLE ONLY __SCHEMA__.client_channels
    ADD CONSTRAINT client_channels_client_id_fkey FOREIGN KEY (client_id) REFERENCES __SCHEMA__.clients(client_id) ON DELETE CASCADE;
ALTER TABLE ONLY __SCHEMA__.conversations
    ADD CONSTRAINT conversations_appointment_id_fkey FOREIGN KEY (appointment_id) REFERENCES __SCHEMA__.appointments(appointment_id) ON DELETE SET NULL;
ALTER TABLE ONLY __SCHEMA__.conversations
    ADD CONSTRAINT conversations_client_id_fkey FOREIGN KEY (client_id) REFERENCES __SCHEMA__.clients(client_id) ON DELETE SET NULL;
ALTER TABLE ONLY __SCHEMA__.master_accounts
    ADD CONSTRAINT master_accounts_master_id_fkey FOREIGN KEY (master_id) REFERENCES __SCHEMA__.masters(master_id) ON DELETE CASCADE;
ALTER TABLE ONLY __SCHEMA__.master_services
    ADD CONSTRAINT master_services_master_id_fkey FOREIGN KEY (master_id) REFERENCES __SCHEMA__.masters(master_id) ON DELETE CASCADE;
ALTER TABLE ONLY __SCHEMA__.master_services
    ADD CONSTRAINT master_services_service_code_fkey FOREIGN KEY (service_code) REFERENCES __SCHEMA__.services(service_code) ON DELETE CASCADE;
ALTER TABLE ONLY __SCHEMA__.messages
    ADD CONSTRAINT messages_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES __SCHEMA__.conversations(conversation_id) ON DELETE CASCADE;
ALTER TABLE ONLY __SCHEMA__.messages
    ADD CONSTRAINT messages_payment_id_fkey FOREIGN KEY (payment_id) REFERENCES __SCHEMA__.payments(payment_id) ON DELETE SET NULL;
ALTER TABLE ONLY __SCHEMA__.payments
    ADD CONSTRAINT payments_appointment_id_fkey FOREIGN KEY (appointment_id) REFERENCES __SCHEMA__.appointments(appointment_id) ON DELETE CASCADE;
