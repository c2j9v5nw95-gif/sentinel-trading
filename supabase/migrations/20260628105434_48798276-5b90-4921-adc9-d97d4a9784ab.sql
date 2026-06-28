
ALTER TABLE public.coin_admission_results
  ADD COLUMN IF NOT EXISTS historical_trend_quality numeric,
  ADD COLUMN IF NOT EXISTS htq_components jsonb,
  ADD COLUMN IF NOT EXISTS htq_lookback_days integer,
  ADD COLUMN IF NOT EXISTS htq_mode text,
  ADD COLUMN IF NOT EXISTS trend_classification text,
  ADD COLUMN IF NOT EXISTS htq_reason text,
  ADD COLUMN IF NOT EXISTS current_momentum_score numeric,
  ADD COLUMN IF NOT EXISTS strategy_fit_label text;

ALTER TABLE public.coin_admission_profiles
  ADD COLUMN IF NOT EXISTS htq_default_lookback_days integer NOT NULL DEFAULT 30,
  ADD COLUMN IF NOT EXISTS htq_min_trend_friendly numeric NOT NULL DEFAULT 75,
  ADD COLUMN IF NOT EXISTS htq_min_neutral numeric NOT NULL DEFAULT 55;

ALTER TABLE public.coin_admission_runs
  ADD COLUMN IF NOT EXISTS htq_lookback_days integer,
  ADD COLUMN IF NOT EXISTS htq_mode text;
