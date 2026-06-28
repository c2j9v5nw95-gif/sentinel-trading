
-- Add Trend Adjusted Admission columns to results & runs
ALTER TABLE public.coin_admission_results
  ADD COLUMN IF NOT EXISTS trend_score numeric,
  ADD COLUMN IF NOT EXISTS trend_components jsonb,
  ADD COLUMN IF NOT EXISTS strategy_fit_score numeric,
  ADD COLUMN IF NOT EXISTS hard_kill_rules text[],
  ADD COLUMN IF NOT EXISTS soft_failures text[],
  ADD COLUMN IF NOT EXISTS admission_reason text,
  ADD COLUMN IF NOT EXISTS admission_mode text;

ALTER TABLE public.coin_admission_runs
  ADD COLUMN IF NOT EXISTS admission_mode text NOT NULL DEFAULT 'strict',
  ADD COLUMN IF NOT EXISTS include_trend_quality boolean NOT NULL DEFAULT false;

-- Reseed presets with new thresholds (trend candidate + strategy fit fields)
UPDATE public.coin_admission_profiles
SET thresholds = thresholds
  || jsonb_build_object(
    'trend_adjusted_enabled', false,
    'min_trend_score_for_soften', 75,
    'trend_candidate_min_robustness', 55,
    'trend_candidate_min_trend', 75,
    'strategy_fit_weight_robustness', 0.6,
    'strategy_fit_weight_trend', 0.4
  )
WHERE name = 'conservative';

UPDATE public.coin_admission_profiles
SET thresholds = thresholds
  || jsonb_build_object(
    'trend_adjusted_enabled', true,
    'min_trend_score_for_soften', 75,
    'trend_candidate_min_robustness', 55,
    'trend_candidate_min_trend', 75,
    'strategy_fit_weight_robustness', 0.6,
    'strategy_fit_weight_trend', 0.4
  )
WHERE name = 'aggressive';
