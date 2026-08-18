-- Add nullable geographic coordinates to families for the delivery-groups
-- feature. Backward-compatible: existing INSERT/UPDATE without lat/lng keep
-- working. RLS policy on public.families is already permissive; no policy
-- changes needed.

ALTER TABLE public.families
  ADD COLUMN IF NOT EXISTS latitude  float8,
  ADD COLUMN IF NOT EXISTS longitude float8;
