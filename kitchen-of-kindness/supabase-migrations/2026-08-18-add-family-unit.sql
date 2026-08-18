-- Separate unit/apartment number from the street address so Google
-- autocomplete gets a clean street address and the unit can't be lost.

ALTER TABLE public.families
  ADD COLUMN IF NOT EXISTS unit text;
