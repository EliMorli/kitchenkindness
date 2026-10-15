-- Mail: a Gmail folder for every kind of email (Kitchen of Kindness/New
-- Applications, Approved, Declined, Volunteers, Donations, Questions and
-- Other, Newsletters and Ads), and newsletters waiting to be filed.
-- Applied to production on 2026-10-15 via Supabase MCP/SQL. Kept for reference.

ALTER TABLE public.mail_requests DROP CONSTRAINT IF EXISTS mail_requests_gmail_label_check;
ALTER TABLE public.mail_requests ADD CONSTRAINT mail_requests_gmail_label_check
  CHECK (gmail_label IN ('none', 'applications', 'approved', 'declined', 'volunteers', 'donations', 'questions', 'newsletters'));

-- Automated mailing-list / bulk emails to file into "Newsletters and Ads".
ALTER TABLE public.mail_messages ADD COLUMN IF NOT EXISTS gmail_dirty boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS mail_messages_dirty_idx ON public.mail_messages (gmail_dirty) WHERE gmail_dirty;

-- Create the new folders on the next Live check.
UPDATE public.mail_settings SET labels_ready = false;
