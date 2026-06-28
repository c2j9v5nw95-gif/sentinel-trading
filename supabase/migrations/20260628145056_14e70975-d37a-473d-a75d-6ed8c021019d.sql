
ALTER TABLE coin_backtest_results DROP CONSTRAINT IF EXISTS coin_backtest_results_label_check;
ALTER TABLE coin_backtest_results DROP CONSTRAINT IF EXISTS coin_backtest_results_auto_suggested_label_check;
ALTER TABLE coin_backtest_results DROP CONSTRAINT IF EXISTS auto_suggested_label_check;

ALTER TABLE coin_backtest_results
  ADD CONSTRAINT coin_backtest_results_label_check
  CHECK (label = ANY (ARRAY['no_trades','rejected_backtest','marginal','profitable','profitable_plus']::text[]));
ALTER TABLE coin_backtest_results
  ADD CONSTRAINT coin_backtest_results_auto_suggested_label_check
  CHECK (auto_suggested_label IS NULL OR auto_suggested_label = ANY (ARRAY['no_trades','rejected_backtest','marginal','profitable','profitable_plus']::text[]));

ALTER TABLE coin_backtest_results
  ADD COLUMN IF NOT EXISTS backtest_quality_score numeric,
  ADD COLUMN IF NOT EXISTS classification_reason_codes text[] DEFAULT '{}'::text[],
  ADD COLUMN IF NOT EXISTS classification_positive_drivers jsonb,
  ADD COLUMN IF NOT EXISTS classification_negative_drivers jsonb,
  ADD COLUMN IF NOT EXISTS classification_safety_overrides text[] DEFAULT '{}'::text[],
  ADD COLUMN IF NOT EXISTS classification_summary text,
  ADD COLUMN IF NOT EXISTS label_source text DEFAULT 'auto',
  ADD COLUMN IF NOT EXISTS label_overridden_at timestamptz,
  ADD COLUMN IF NOT EXISTS label_overridden_by uuid,
  ADD COLUMN IF NOT EXISTS label_config_version text,
  ADD COLUMN IF NOT EXISTS needs_review boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS needs_review_reason text;

ALTER TABLE coin_backtest_results DROP CONSTRAINT IF EXISTS label_source_check;
ALTER TABLE coin_backtest_results
  ADD CONSTRAINT label_source_check
  CHECK (label_source = ANY (ARRAY['auto','manual_override']::text[]));

CREATE INDEX IF NOT EXISTS coin_backtest_results_needs_review_idx
  ON coin_backtest_results (needs_review) WHERE needs_review = true;
CREATE INDEX IF NOT EXISTS coin_backtest_results_label_idx
  ON coin_backtest_results (label);

ALTER TABLE app_settings
  ADD COLUMN IF NOT EXISTS calibration_exclude_no_trades boolean DEFAULT true,
  ADD COLUMN IF NOT EXISTS calibration_exclude_needs_review boolean DEFAULT true,
  ADD COLUMN IF NOT EXISTS backtest_label_config_version text DEFAULT 'v2';

UPDATE app_settings
SET calibration_k = 10,
    calibration_min_neighbors_medium = 4,
    calibration_min_neighbors_high = 10
WHERE singleton = true;

UPDATE coin_backtest_results
SET label = 'no_trades',
    auto_suggested_label = 'no_trades',
    label_source = 'auto',
    classification_reason_codes = ARRAY['no_trades']::text[],
    classification_summary = 'No trades during test period — strategy found no valid setup.',
    needs_review = false,
    needs_review_reason = NULL,
    label_config_version = 'v2-backfill'
WHERE num_trades = 0;

UPDATE coin_backtest_results
SET label_source = COALESCE(label_source, 'auto'),
    needs_review = true,
    needs_review_reason = 'phase0_backfill: classifier upgraded — please review',
    label_config_version = COALESCE(label_config_version, 'v1-pre-phase0')
WHERE num_trades > 0 AND label_source IS DISTINCT FROM 'manual_override';
