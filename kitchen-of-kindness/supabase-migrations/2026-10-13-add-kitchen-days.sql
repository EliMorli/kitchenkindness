-- Per-day kitchen progress for the Kitchen Live page (/admin/live):
-- when labels were printed (bags are being packed), when the WhatsApp list
-- was copied (volunteers pick groups there), and when the admin marked the
-- day delivered. Applied to production on 2026-10-13 via Supabase SQL.
-- (Function body is single-quoted on purpose: the SQL tool times out on
-- dollar-quoted blocks.)

CREATE TABLE IF NOT EXISTS public.kitchen_days (
  delivery_date   date PRIMARY KEY,
  printed_at      timestamptz,
  printed_labels  integer,
  copied_at       timestamptz,
  delivered_at    timestamptz,
  updated_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.kitchen_days ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all operations" ON public.kitchen_days FOR ALL USING (true) WITH CHECK (true);

CREATE OR REPLACE FUNCTION public.kitchen_days_touch()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS 'BEGIN NEW.updated_at := now(); RETURN NEW; END';

CREATE TRIGGER kitchen_days_touch
  BEFORE UPDATE ON public.kitchen_days
  FOR EACH ROW EXECUTE FUNCTION public.kitchen_days_touch();

-- Live updates: the phone page moves when the kitchen PC prints.
ALTER PUBLICATION supabase_realtime ADD TABLE public.kitchen_days;
