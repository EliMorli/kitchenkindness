-- Special orders per special week + temporary family pauses.
-- Applied to production on 2026-09-08 via Supabase MCP. Kept for reference.

CREATE TABLE IF NOT EXISTS public.volunteer_week_orders (
  id             bigserial PRIMARY KEY,
  week_id        bigint NOT NULL REFERENCES public.volunteer_weeks(id) ON DELETE CASCADE,
  family_id      integer,
  label          text NOT NULL DEFAULT '',
  address        text NOT NULL DEFAULT '',
  unit           text NOT NULL DEFAULT '',
  contact        text NOT NULL DEFAULT '',
  instructions   text NOT NULL DEFAULT '',
  notes          text NOT NULL DEFAULT '',
  people_count   integer NOT NULL DEFAULT 1,
  delivery_date  date,
  sort_order     integer NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS volunteer_week_orders_week_idx ON public.volunteer_week_orders(week_id);

CREATE TABLE IF NOT EXISTS public.family_pauses (
  id          bigserial PRIMARY KEY,
  family_id   integer NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('day', 'saturday')),
  day_name    text,
  start_date  date NOT NULL,
  end_date    date NOT NULL,
  reason      text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS family_pauses_family_idx ON public.family_pauses(family_id);
CREATE INDEX IF NOT EXISTS family_pauses_end_idx ON public.family_pauses(end_date);

ALTER TABLE public.volunteer_week_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.family_pauses ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all operations" ON public.volunteer_week_orders FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all operations" ON public.family_pauses FOR ALL USING (true) WITH CHECK (true);
