-- Optional time window shown on each special-week day ("10am – 2pm").
-- Applied to production on 2026-09-06 via Supabase MCP.

ALTER TABLE public.volunteer_week_days
  ADD COLUMN IF NOT EXISTS time_label text NOT NULL DEFAULT '';
