
-- 1. coin_backtest_results
CREATE TABLE public.coin_backtest_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  symbol text NOT NULL,
  test_date date NOT NULL DEFAULT CURRENT_DATE,
  strategy_version text NOT NULL,

  admission_result_id uuid REFERENCES public.coin_admission_results(id) ON DELETE SET NULL,
  admission_run_id uuid REFERENCES public.coin_admission_runs(id) ON DELETE SET NULL,
  screener_snapshot jsonb,

  timeframe text NOT NULL DEFAULT '5m',
  candles_tested integer NOT NULL DEFAULT 9000,
  lookback_equivalent_days numeric,

  -- Confirmed backtest metrics
  net_profit_pct numeric,
  net_profit_usd numeric,
  max_drawdown_pct numeric,
  max_drawdown_usd numeric,
  profit_factor numeric,
  win_rate_pct numeric,
  num_trades integer,
  avg_pnl_pct numeric,
  avg_bars_in_trade numeric,
  expected_payoff_usd numeric,
  sharpe_ratio numeric,
  largest_profit_usd numeric,
  largest_loss_usd numeric,
  profitable_trades_count integer,
  losing_trades_count integer,

  -- Classification
  label text NOT NULL CHECK (label IN ('rejected_backtest','marginal','profitable','profitable_plus')),
  auto_suggested_label text CHECK (auto_suggested_label IN ('rejected_backtest','marginal','profitable','profitable_plus')),
  notes text,

  -- Screenshot / OCR
  screenshot_storage_path text,
  extraction_source text NOT NULL DEFAULT 'manual' CHECK (extraction_source IN ('manual','screenshot_ocr')),
  extraction_status text NOT NULL DEFAULT 'manual' CHECK (extraction_status IN ('manual','pending_review','confirmed','failed')),
  extraction_confidence numeric,
  extracted_raw_text text,
  extracted_metrics jsonb,
  field_confidences jsonb
);

-- Soft-dedupe: blokker kun ekte dobbeltregistrering
CREATE UNIQUE INDEX coin_backtest_results_soft_dedupe
  ON public.coin_backtest_results (
    user_id, symbol, strategy_version, test_date,
    COALESCE(admission_result_id, '00000000-0000-0000-0000-000000000000'::uuid)
  );

CREATE INDEX coin_backtest_results_symbol_date_idx
  ON public.coin_backtest_results (symbol, test_date DESC);
CREATE INDEX coin_backtest_results_user_created_idx
  ON public.coin_backtest_results (user_id, created_at DESC);
CREATE INDEX coin_backtest_results_strategy_version_idx
  ON public.coin_backtest_results (strategy_version);
CREATE INDEX coin_backtest_results_label_idx
  ON public.coin_backtest_results (label);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.coin_backtest_results TO authenticated;
GRANT ALL ON public.coin_backtest_results TO service_role;

ALTER TABLE public.coin_backtest_results ENABLE ROW LEVEL SECURITY;

CREATE POLICY "owners select own backtest results"
  ON public.coin_backtest_results FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

CREATE POLICY "owners insert own backtest results"
  ON public.coin_backtest_results FOR INSERT
  TO authenticated
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "owners update own backtest results"
  ON public.coin_backtest_results FOR UPDATE
  TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "owners delete own backtest results"
  ON public.coin_backtest_results FOR DELETE
  TO authenticated
  USING (user_id = auth.uid());

CREATE TRIGGER t_coin_backtest_results_u
  BEFORE UPDATE ON public.coin_backtest_results
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- 2. coin_admission_results: calibration fields
ALTER TABLE public.coin_admission_results
  ADD COLUMN calibration_score numeric,
  ADD COLUMN calibration_confidence text CHECK (calibration_confidence IN ('low','medium','high')),
  ADD COLUMN calibration_label text CHECK (calibration_label IN ('rejected_backtest','marginal','profitable','profitable_plus')),
  ADD COLUMN calibration_neighbors jsonb,
  ADD COLUMN calibrated_strategy_fit numeric,
  ADD COLUMN calibration_strategy_version text,
  ADD COLUMN calibration_status text CHECK (calibration_status IN ('ok','unavailable')),
  ADD COLUMN calibration_reason text,
  ADD COLUMN calibration_computed_at timestamptz;

-- 3. app_settings: calibration config
ALTER TABLE public.app_settings
  ADD COLUMN calibration_half_life_days integer NOT NULL DEFAULT 180,
  ADD COLUMN calibration_k integer NOT NULL DEFAULT 5,
  ADD COLUMN calibration_min_neighbors_medium integer NOT NULL DEFAULT 3,
  ADD COLUMN calibration_min_neighbors_high integer NOT NULL DEFAULT 6,
  ADD COLUMN calibration_default_strategy_version text,
  ADD COLUMN calibration_ocr_model text NOT NULL DEFAULT 'google/gemini-3-flash-preview',
  ADD COLUMN calibration_include_default boolean NOT NULL DEFAULT true;
