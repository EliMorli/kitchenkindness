-- Mail intake for the admin "Mail" tab: emails from the kitchen's Gmail
-- inbox, summarized by Claude, approved or declined by the admin.
--
-- PRIVATE: these tables hold personal details from emails. RLS is on with NO
-- policies and anon/authenticated have no grants, so only the service role
-- (the app's server routes) can read or write them. Do not add an
-- "Allow all operations" policy and do not add them to supabase_realtime.
--
-- Applied to production on 2026-10-14 via Supabase MCP/SQL. Kept for reference.
-- Function bodies are single-quoted on purpose (the SQL tool times out on
-- dollar-quoted blocks).

-- One row per Gmail conversation (thread): the item in the admin's queue.
CREATE TABLE IF NOT EXISTS public.mail_requests (
  id bigserial PRIMARY KEY,
  gmail_thrid text NOT NULL UNIQUE,
  kind text NOT NULL DEFAULT 'unknown' CHECK (kind IN ('unknown', 'request', 'other')),
  kind_set_by text NOT NULL DEFAULT 'ai' CHECK (kind_set_by IN ('ai', 'admin')),
  status text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'pending', 'approved', 'declined', 'other')),
  from_name text NOT NULL DEFAULT '',
  from_email text NOT NULL DEFAULT '',
  reply_address text NOT NULL DEFAULT '',
  reply_key text NOT NULL DEFAULT '',
  subject text NOT NULL DEFAULT '',
  first_message_at timestamptz NOT NULL DEFAULT now(),
  last_message_at timestamptz NOT NULL DEFAULT now(),
  message_count integer NOT NULL DEFAULT 1,
  needs_attention boolean NOT NULL DEFAULT false,
  ai_status text NOT NULL DEFAULT 'due' CHECK (ai_status IN ('due', 'done', 'failed')),
  ai_attempts integer NOT NULL DEFAULT 0,
  ai_summary text NOT NULL DEFAULT '',
  ai_fields jsonb NOT NULL DEFAULT '{}'::jsonb,
  ai_model text NOT NULL DEFAULT '',
  ai_error text NOT NULL DEFAULT '',
  ai_at timestamptz,
  geo jsonb,
  auto_reply_status text NOT NULL DEFAULT 'not_needed'
    CHECK (auto_reply_status IN ('not_needed', 'wait_ai', 'due', 'claimed', 'sent', 'failed', 'unknown', 'skipped')),
  auto_reply_attempts integer NOT NULL DEFAULT 0,
  auto_reply_forced boolean NOT NULL DEFAULT false,
  auto_reply_claimed_at timestamptz,
  auto_reply_message_id text NOT NULL DEFAULT '',
  auto_replied_at timestamptz,
  auto_reply_error text NOT NULL DEFAULT '',
  family_id integer,
  approved_family jsonb,
  decided_at timestamptz,
  approval_email_status text NOT NULL DEFAULT 'not_needed'
    CHECK (approval_email_status IN ('not_needed', 'due', 'claimed', 'sent', 'failed', 'unknown')),
  approval_email_attempts integer NOT NULL DEFAULT 0,
  approval_email_claimed_at timestamptz,
  approval_email_message_id text NOT NULL DEFAULT '',
  approval_email_sent_at timestamptz,
  approval_email_error text NOT NULL DEFAULT '',
  gmail_label text NOT NULL DEFAULT 'none' CHECK (gmail_label IN ('none', 'pending', 'approved', 'declined')),
  gmail_in_inbox boolean NOT NULL DEFAULT true,
  gmail_seen boolean NOT NULL DEFAULT false,
  gmail_dirty boolean NOT NULL DEFAULT true,
  gmail_error text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mail_requests_status_idx ON public.mail_requests (status, last_message_at DESC);
CREATE INDEX IF NOT EXISTS mail_requests_reply_key_idx ON public.mail_requests (reply_key);
CREATE INDEX IF NOT EXISTS mail_requests_dirty_idx ON public.mail_requests (gmail_dirty) WHERE gmail_dirty;

-- One row per Gmail message seen in the inbox (dedupe, bodies, threading headers).
CREATE TABLE IF NOT EXISTS public.mail_messages (
  id bigserial PRIMARY KEY,
  gmail_msgid text NOT NULL UNIQUE,
  gmail_thrid text NOT NULL,
  request_id bigint REFERENCES public.mail_requests(id) ON DELETE CASCADE,
  inbox_uid bigint,
  message_id_header text NOT NULL DEFAULT '',
  in_reply_to text NOT NULL DEFAULT '',
  references_header text NOT NULL DEFAULT '',
  from_name text NOT NULL DEFAULT '',
  from_email text NOT NULL DEFAULT '',
  reply_to_email text NOT NULL DEFAULT '',
  subject text NOT NULL DEFAULT '',
  received_at timestamptz NOT NULL DEFAULT now(),
  automated_reason text NOT NULL DEFAULT '',
  auth_pass boolean NOT NULL DEFAULT false,
  body_text text NOT NULL DEFAULT '',
  attachment_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mail_messages_thread_idx ON public.mail_messages (gmail_thrid, received_at);
CREATE INDEX IF NOT EXISTS mail_messages_request_idx ON public.mail_messages (request_id);
CREATE INDEX IF NOT EXISTS mail_messages_message_id_idx ON public.mail_messages (message_id_header);

-- Single settings row: mode, templates, sync cursor and lock.
CREATE TABLE IF NOT EXISTS public.mail_settings (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  mode text NOT NULL DEFAULT 'off' CHECK (mode IN ('off', 'shadow', 'live')),
  auto_reply_enabled boolean NOT NULL DEFAULT true,
  auto_reply_scope text NOT NULL DEFAULT 'all' CHECK (auto_reply_scope IN ('all', 'requests')),
  auto_reply_since timestamptz,
  auto_reply_body text NOT NULL DEFAULT '',
  approval_body text NOT NULL DEFAULT '',
  no_reply_senders text NOT NULL DEFAULT '',
  inbox_uidvalidity text,
  inbox_last_uid bigint,
  inbox_fail_uid bigint,
  inbox_fail_count integer NOT NULL DEFAULT 0,
  labels_ready boolean NOT NULL DEFAULT false,
  sync_lock_holder text,
  sync_lock_until timestamptz,
  last_sync_at timestamptz,
  last_sync_ok_at timestamptz,
  last_sync_error text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.mail_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- Private: RLS on, deliberately no policies, no grants for the public roles.
ALTER TABLE public.mail_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mail_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mail_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.mail_requests, public.mail_messages, public.mail_settings FROM anon, authenticated;
REVOKE ALL ON SEQUENCE public.mail_requests_id_seq, public.mail_messages_id_seq FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.mail_touch() RETURNS trigger LANGUAGE plpgsql SET search_path = ''
  AS 'BEGIN NEW.updated_at := now(); RETURN NEW; END';
CREATE TRIGGER mail_requests_touch BEFORE UPDATE ON public.mail_requests FOR EACH ROW EXECUTE FUNCTION public.mail_touch();
CREATE TRIGGER mail_settings_touch BEFORE UPDATE ON public.mail_settings FOR EACH ROW EXECUTE FUNCTION public.mail_touch();

-- One sync run at a time: a lease on the settings row.
CREATE OR REPLACE FUNCTION public.mail_try_lock(p_holder text, p_seconds integer)
RETURNS boolean LANGUAGE sql SET search_path = '' AS '
  WITH got AS (
    UPDATE public.mail_settings
       SET sync_lock_holder = p_holder, sync_lock_until = now() + make_interval(secs => p_seconds)
     WHERE id = 1 AND (sync_lock_until IS NULL OR sync_lock_until < now())
    RETURNING 1)
  SELECT EXISTS (SELECT 1 FROM got)';

-- Approve: create the family and mark the request approved in one
-- transaction. Calling it again for an approved request returns the same
-- family number (double taps and retries are safe).
CREATE OR REPLACE FUNCTION public.mail_approve_request(p_request_id bigint, p_family jsonb, p_send_email boolean)
RETURNS integer LANGUAGE plpgsql SET search_path = '' AS '
DECLARE
  r public.mail_requests%ROWTYPE;
  v_id integer;
BEGIN
  SELECT * INTO r FROM public.mail_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION ''request_not_found''; END IF;
  IF r.status = ''approved'' THEN RETURN r.family_id; END IF;
  IF r.status NOT IN (''pending'', ''other'', ''new'') THEN RAISE EXCEPTION ''request_is_%'', r.status; END IF;
  PERFORM pg_advisory_xact_lock(4242001);
  SELECT GREATEST(COALESCE(MAX(family_id), 349) + 1, 350) INTO v_id FROM public.families;
  INSERT INTO public.families (family_id, address, unit, instructions, contact, people_count,
      delivery_days, notes, saturday_meals, active, latitude, longitude)
  VALUES (v_id,
      p_family->>''address'',
      NULLIF(p_family->>''unit'', ''''),
      COALESCE(NULLIF(p_family->>''instructions'', ''''), ''Leave at door''),
      COALESCE(p_family->>''contact'', ''''),
      (p_family->>''people_count'')::int,
      ARRAY(SELECT jsonb_array_elements_text(p_family->''delivery_days'')),
      COALESCE(p_family->>''notes'', ''''),
      COALESCE((p_family->>''saturday_meals'')::boolean, false),
      true,
      (p_family->>''latitude'')::float8,
      (p_family->>''longitude'')::float8);
  UPDATE public.mail_requests
     SET status = ''approved'', kind = ''request'', kind_set_by = ''admin'', family_id = v_id, approved_family = p_family,
         decided_at = now(), needs_attention = false, gmail_dirty = true,
         approval_email_status = CASE WHEN p_send_email AND r.reply_address <> '''' THEN ''due'' ELSE ''not_needed'' END
   WHERE id = p_request_id;
  RETURN v_id;
END';

-- Counts for the Mail tab in one row (a plain select is capped at 1000 rows).
CREATE OR REPLACE FUNCTION public.mail_counts()
RETURNS json LANGUAGE sql STABLE SET search_path = '' AS '
  SELECT json_build_object(
    ''pending'', count(*) FILTER (WHERE status IN (''new'', ''pending'')),
    ''approved'', count(*) FILTER (WHERE status = ''approved''),
    ''declined'', count(*) FILTER (WHERE status = ''declined''),
    ''other'', count(*) FILTER (WHERE status = ''other''),
    ''attention'', count(*) FILTER (WHERE needs_attention))
  FROM public.mail_requests';

REVOKE ALL ON FUNCTION public.mail_try_lock(text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mail_counts() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mail_counts() TO service_role;
REVOKE ALL ON FUNCTION public.mail_approve_request(bigint, jsonb, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mail_touch() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mail_try_lock(text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.mail_approve_request(bigint, jsonb, boolean) TO service_role;
