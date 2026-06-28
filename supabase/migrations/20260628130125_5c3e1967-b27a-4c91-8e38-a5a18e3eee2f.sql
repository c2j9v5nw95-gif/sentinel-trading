
-- 1) Sizing/leverage columns on coin_backtest_results
ALTER TABLE public.coin_backtest_results
  ADD COLUMN IF NOT EXISTS initial_capital_usd numeric DEFAULT 10000,
  ADD COLUMN IF NOT EXISTS position_size_type text DEFAULT 'percent_of_equity',
  ADD COLUMN IF NOT EXISTS position_size_pct numeric DEFAULT 5,
  ADD COLUMN IF NOT EXISTS position_size_usd numeric,
  ADD COLUMN IF NOT EXISTS leverage numeric DEFAULT 10,
  ADD COLUMN IF NOT EXISTS leverage_enabled boolean DEFAULT true,
  ADD COLUMN IF NOT EXISTS notional_exposure_pct numeric,
  ADD COLUMN IF NOT EXISTS normalized_net_profit_pct numeric,
  ADD COLUMN IF NOT EXISTS normalized_drawdown_pct numeric,
  ADD COLUMN IF NOT EXISTS normalized_avg_trade_pct numeric,
  ADD COLUMN IF NOT EXISTS leverage_adjusted_net_profit_pct numeric,
  ADD COLUMN IF NOT EXISTS leverage_adjusted_drawdown_pct numeric,
  ADD COLUMN IF NOT EXISTS sizing_assumption_source text DEFAULT 'default_backfill';

-- Drop & re-add check constraint idempotently
ALTER TABLE public.coin_backtest_results
  DROP CONSTRAINT IF EXISTS coin_backtest_results_sizing_source_chk;
ALTER TABLE public.coin_backtest_results
  ADD CONSTRAINT coin_backtest_results_sizing_source_chk
  CHECK (sizing_assumption_source IN ('default_backfill','user_confirmed','imported_from_screenshot','manual_override'));

-- 2) Backfill existing rows with sizing defaults (only fill nulls — never touch TV numbers)
UPDATE public.coin_backtest_results
SET initial_capital_usd      = COALESCE(initial_capital_usd, 10000),
    position_size_type       = COALESCE(position_size_type, 'percent_of_equity'),
    position_size_pct        = COALESCE(position_size_pct, 5),
    leverage                 = COALESCE(leverage, 10),
    leverage_enabled         = COALESCE(leverage_enabled, true),
    sizing_assumption_source = COALESCE(sizing_assumption_source, 'default_backfill');

-- Compute notional_exposure_pct
UPDATE public.coin_backtest_results
SET notional_exposure_pct =
  CASE WHEN COALESCE(leverage_enabled, true)
       THEN COALESCE(position_size_pct, 5) * COALESCE(leverage, 10)
       ELSE COALESCE(position_size_pct, 5)
  END
WHERE notional_exposure_pct IS NULL;

-- Compute normalized + leverage-adjusted derived metrics where inputs exist
UPDATE public.coin_backtest_results
SET normalized_net_profit_pct =
      CASE WHEN net_profit_pct IS NOT NULL AND COALESCE(position_size_pct,0) > 0
           THEN net_profit_pct / (position_size_pct / 100.0) END,
    normalized_drawdown_pct =
      CASE WHEN max_drawdown_pct IS NOT NULL AND COALESCE(position_size_pct,0) > 0
           THEN max_drawdown_pct / (position_size_pct / 100.0) END,
    normalized_avg_trade_pct =
      CASE WHEN avg_pnl_pct IS NOT NULL AND COALESCE(position_size_pct,0) > 0
           THEN avg_pnl_pct / (position_size_pct / 100.0) END,
    leverage_adjusted_net_profit_pct =
      CASE WHEN net_profit_pct IS NOT NULL THEN
        CASE WHEN COALESCE(leverage_enabled, true) AND COALESCE(leverage,1) >= 1
             THEN net_profit_pct * leverage
             ELSE net_profit_pct END
      END,
    leverage_adjusted_drawdown_pct =
      CASE WHEN max_drawdown_pct IS NOT NULL THEN
        CASE WHEN COALESCE(leverage_enabled, true) AND COALESCE(leverage,1) >= 1
             THEN max_drawdown_pct * leverage
             ELSE max_drawdown_pct END
      END;

-- 3) Classification thresholds in app_settings (configurable in v1)
ALTER TABLE public.app_settings
  ADD COLUMN IF NOT EXISTS backtest_min_trades integer DEFAULT 20,
  ADD COLUMN IF NOT EXISTS backtest_marginal_min_profit_factor numeric DEFAULT 1.05,
  ADD COLUMN IF NOT EXISTS backtest_profitable_min_profit_factor numeric DEFAULT 1.20,
  ADD COLUMN IF NOT EXISTS backtest_profitable_plus_min_profit_factor numeric DEFAULT 1.50,
  ADD COLUMN IF NOT EXISTS backtest_profitable_min_normalized_net_profit_pct numeric DEFAULT 20,
  ADD COLUMN IF NOT EXISTS backtest_profitable_plus_min_normalized_net_profit_pct numeric DEFAULT 40,
  ADD COLUMN IF NOT EXISTS backtest_max_leverage_adjusted_drawdown_profitable numeric DEFAULT 30,
  ADD COLUMN IF NOT EXISTS backtest_max_leverage_adjusted_drawdown_profitable_plus numeric DEFAULT 25;

UPDATE public.app_settings
SET backtest_min_trades = COALESCE(backtest_min_trades, 20),
    backtest_marginal_min_profit_factor = COALESCE(backtest_marginal_min_profit_factor, 1.05),
    backtest_profitable_min_profit_factor = COALESCE(backtest_profitable_min_profit_factor, 1.20),
    backtest_profitable_plus_min_profit_factor = COALESCE(backtest_profitable_plus_min_profit_factor, 1.50),
    backtest_profitable_min_normalized_net_profit_pct = COALESCE(backtest_profitable_min_normalized_net_profit_pct, 20),
    backtest_profitable_plus_min_normalized_net_profit_pct = COALESCE(backtest_profitable_plus_min_normalized_net_profit_pct, 40),
    backtest_max_leverage_adjusted_drawdown_profitable = COALESCE(backtest_max_leverage_adjusted_drawdown_profitable, 30),
    backtest_max_leverage_adjusted_drawdown_profitable_plus = COALESCE(backtest_max_leverage_adjusted_drawdown_profitable_plus, 25)
WHERE singleton = true;
