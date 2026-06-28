ALTER TABLE coin_backtest_results
  ADD COLUMN IF NOT EXISTS sample_bucket text,
  ADD COLUMN IF NOT EXISTS sample_confidence_weight numeric;

ALTER TABLE coin_backtest_results DROP CONSTRAINT IF EXISTS coin_backtest_results_sample_bucket_check;
ALTER TABLE coin_backtest_results
  ADD CONSTRAINT coin_backtest_results_sample_bucket_check
  CHECK (
    sample_bucket IS NULL OR sample_bucket = ANY (ARRAY[
      'no_trades',
      'very_low_sample',
      'low_sample',
      'acceptable_sample',
      'good_sample',
      'strong_sample'
    ]::text[])
  );

CREATE INDEX IF NOT EXISTS coin_backtest_results_sample_bucket_idx
  ON coin_backtest_results (sample_bucket);

UPDATE coin_backtest_results
SET
  sample_bucket = CASE
    WHEN num_trades IS NULL OR num_trades = 0 THEN 'no_trades'
    WHEN num_trades BETWEEN 1 AND 3   THEN 'very_low_sample'
    WHEN num_trades BETWEEN 4 AND 7   THEN 'low_sample'
    WHEN num_trades BETWEEN 8 AND 12  THEN 'acceptable_sample'
    WHEN num_trades BETWEEN 13 AND 19 THEN 'good_sample'
    ELSE 'strong_sample'
  END,
  sample_confidence_weight = CASE
    WHEN num_trades IS NULL OR num_trades = 0 THEN 0.0
    WHEN num_trades BETWEEN 1 AND 3   THEN 0.15
    WHEN num_trades BETWEEN 4 AND 7   THEN 0.35
    WHEN num_trades BETWEEN 8 AND 12  THEN 0.75
    WHEN num_trades BETWEEN 13 AND 19 THEN 0.90
    ELSE 1.00
  END
WHERE sample_bucket IS NULL;

UPDATE app_settings
SET backtest_label_config_version = 'v3-strategy-aware'
WHERE singleton = true;
