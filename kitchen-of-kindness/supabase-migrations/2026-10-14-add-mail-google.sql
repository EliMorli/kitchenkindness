-- "Sign in with Google" for the Mail tab: the connected Gmail account.
--
-- PRIVATE: mail_google holds the (encrypted) refresh token that gives access
-- to the kitchen's Gmail. RLS is on with NO policies and anon/authenticated
-- have no grants, so only the service role (the app's server routes) can read
-- it. The token is also encrypted by the app (key from ADMIN_SESSION_SECRET).
--
-- Applied to production via Supabase MCP/SQL. Kept for reference.

CREATE TABLE IF NOT EXISTS public.mail_google (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  email text NOT NULL DEFAULT '',
  refresh_token_enc text NOT NULL DEFAULT '',
  scope text NOT NULL DEFAULT '',
  connected_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.mail_google ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.mail_google FROM anon, authenticated;
CREATE TRIGGER mail_google_touch BEFORE UPDATE ON public.mail_google FOR EACH ROW EXECUTE FUNCTION public.mail_touch();

-- Which account is connected (not secret; shown in Settings) and why it
-- stopped working, if it did.
ALTER TABLE public.mail_settings
  ADD COLUMN IF NOT EXISTS gmail_account text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS gmail_auth_error text NOT NULL DEFAULT '';
