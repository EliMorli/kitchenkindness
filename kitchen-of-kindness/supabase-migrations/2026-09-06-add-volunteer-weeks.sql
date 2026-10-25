-- Reusable "special week" volunteer sign-ups (holiday prep weeks etc.)
-- Applied to production on 2026-09-06 via Supabase MCP. Kept for reference.

CREATE TABLE IF NOT EXISTS public.volunteer_weeks (
  id          bigserial PRIMARY KEY,
  slug        text UNIQUE NOT NULL,
  title       text NOT NULL,
  subtitle    text NOT NULL DEFAULT '',
  emoji       text NOT NULL DEFAULT '🍎',
  start_date  date NOT NULL,
  end_date    date NOT NULL,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.volunteer_week_days (
  id        bigserial PRIMARY KEY,
  week_id   bigint NOT NULL REFERENCES public.volunteer_weeks(id) ON DELETE CASCADE,
  date      date NOT NULL,
  capacity  integer,               -- NULL = unlimited
  note      text NOT NULL DEFAULT '',
  UNIQUE (week_id, date)
);

CREATE TABLE IF NOT EXISTS public.volunteer_week_signups (
  id               bigserial PRIMARY KEY,
  day_id           bigint NOT NULL REFERENCES public.volunteer_week_days(id) ON DELETE CASCADE,
  volunteer_name   text NOT NULL,
  volunteer_phone  text NOT NULL DEFAULT '',
  created_at       timestamptz NOT NULL DEFAULT now(),
  cancelled_at     timestamptz
);

CREATE INDEX IF NOT EXISTS volunteer_week_days_week_idx ON public.volunteer_week_days(week_id);
CREATE INDEX IF NOT EXISTS volunteer_week_signups_day_idx ON public.volunteer_week_signups(day_id);

ALTER TABLE public.volunteer_weeks        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.volunteer_week_days    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.volunteer_week_signups ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all operations" ON public.volunteer_weeks        FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all operations" ON public.volunteer_week_days    FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all operations" ON public.volunteer_week_signups FOR ALL USING (true) WITH CHECK (true);

ALTER PUBLICATION supabase_realtime ADD TABLE public.volunteer_week_signups;

INSERT INTO public.volunteer_weeks (slug, title, subtitle, emoji, start_date, end_date)
VALUES ('rosh-hashanah-2026', 'Rosh Hashanah Prep Week',
        'Help us get the kitchen ready for the holiday — pick a day and come cook with us!',
        '🍎🍯', '2026-09-06', '2026-09-10')
ON CONFLICT (slug) DO NOTHING;

INSERT INTO public.volunteer_week_days (week_id, date, capacity, note)
SELECT w.id, d.date, d.capacity, d.note
FROM public.volunteer_weeks w
CROSS JOIN (VALUES
  ('2026-09-06'::date, 2,    ''),
  ('2026-09-07'::date, 2,    ''),
  ('2026-09-08'::date, 2,    ''),
  ('2026-09-09'::date, 4,    ''),
  ('2026-09-10'::date, NULL, 'Big cooking day — bring friends!')
) AS d(date, capacity, note)
WHERE w.slug = 'rosh-hashanah-2026'
ON CONFLICT (week_id, date) DO NOTHING;
