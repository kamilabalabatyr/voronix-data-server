CREATE EXTENSION IF NOT EXISTS btree_gist SCHEMA public;
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
SET default_tablespace = '';
SET default_table_access_method = heap;
CREATE TABLE public.businesses (
    business_id uuid DEFAULT gen_random_uuid() NOT NULL,
    business_schema text GENERATED ALWAYS AS (('t_'::text || replace((business_id)::text, '-'::text, ''::text))) STORED,
    name character varying(80) NOT NULL,
    country character(2),
    timezone character varying(64) DEFAULT 'UTC'::character varying NOT NULL,
    currency character(3) DEFAULT 'USD'::bpchar NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT businesses_currency_check CHECK ((currency ~ '^[A-Z]{3}$'::text)),
    CONSTRAINT businesses_name_check CHECK ((length(TRIM(BOTH FROM name)) > 0))
);
CREATE TABLE public.password_resets (
    token_hash character(64) NOT NULL,
    user_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    used_at timestamp with time zone,
    CONSTRAINT password_resets_check CHECK ((expires_at > created_at))
);
CREATE TABLE public.schema_migrations (
    version character varying(100) NOT NULL,
    applied_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE public.sessions (
    token_hash character(64) NOT NULL,
    user_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    user_agent character varying(200) DEFAULT ''::character varying NOT NULL,
    CONSTRAINT sessions_check CHECK ((expires_at > created_at))
);
CREATE TABLE public.users (
    user_id uuid DEFAULT gen_random_uuid() NOT NULL,
    business_id uuid NOT NULL,
    email character varying(254) NOT NULL,
    full_name character varying(80) NOT NULL,
    password_hash text,
    google_sub character varying(255),
    email_verified_at timestamp with time zone,
    role character varying(10) DEFAULT 'owner'::character varying NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_login_at timestamp with time zone,
    CONSTRAINT users_check CHECK (((password_hash IS NOT NULL) OR (google_sub IS NOT NULL))),
    CONSTRAINT users_email_check CHECK ((((email)::text = lower((email)::text)) AND ((email)::text ~~ '%_@_%'::text))),
    CONSTRAINT users_role_check CHECK (((role)::text = ANY ((ARRAY['owner'::character varying, 'admin'::character varying, 'staff'::character varying])::text[])))
);
ALTER TABLE ONLY public.businesses
    ADD CONSTRAINT businesses_pkey PRIMARY KEY (business_id);
ALTER TABLE ONLY public.password_resets
    ADD CONSTRAINT password_resets_pkey PRIMARY KEY (token_hash);
ALTER TABLE ONLY public.schema_migrations
    ADD CONSTRAINT schema_migrations_pkey PRIMARY KEY (version);
ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_pkey PRIMARY KEY (token_hash);
ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_key UNIQUE (email);
ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_google_sub_key UNIQUE (google_sub);
ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (user_id);
CREATE INDEX password_resets_user_idx ON public.password_resets USING btree (user_id);
CREATE INDEX sessions_expires_idx ON public.sessions USING btree (expires_at);
CREATE INDEX sessions_user_idx ON public.sessions USING btree (user_id);
CREATE INDEX users_business_idx ON public.users USING btree (business_id);
ALTER TABLE ONLY public.password_resets
    ADD CONSTRAINT password_resets_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(user_id) ON DELETE CASCADE;
ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(user_id) ON DELETE CASCADE;
ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_business_id_fkey FOREIGN KEY (business_id) REFERENCES public.businesses(business_id) ON DELETE CASCADE;
