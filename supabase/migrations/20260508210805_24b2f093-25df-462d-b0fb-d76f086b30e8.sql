
ALTER TABLE public.positions
  ADD COLUMN IF NOT EXISTS tsl_high_water_price numeric,
  ADD COLUMN IF NOT EXISTS tsl_trigger_price numeric,
  ADD COLUMN IF NOT EXISTS last_seen_price numeric;
