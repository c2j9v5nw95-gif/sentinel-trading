-- =====================================================
-- Coin Admission Screener tables
-- =====================================================

-- 1. Mapping Bybit perp symbol → CoinGecko ID
CREATE TABLE public.coin_admission_coingecko_map (
  bybit_symbol text PRIMARY KEY,
  coingecko_id text NOT NULL,
  notes text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.coin_admission_coingecko_map TO authenticated;
GRANT ALL ON public.coin_admission_coingecko_map TO service_role;

ALTER TABLE public.coin_admission_coingecko_map ENABLE ROW LEVEL SECURITY;

CREATE POLICY "operators read mapping" ON public.coin_admission_coingecko_map
  FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'operator'::app_role));

CREATE POLICY "operators write mapping" ON public.coin_admission_coingecko_map
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'operator'::app_role))
  WITH CHECK (public.has_role(auth.uid(), 'operator'::app_role));

-- 2. Profiles (presets)
CREATE TABLE public.coin_admission_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  description text,
  thresholds jsonb NOT NULL,
  weights jsonb NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.coin_admission_profiles TO authenticated;
GRANT ALL ON public.coin_admission_profiles TO service_role;

ALTER TABLE public.coin_admission_profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "operators read profiles" ON public.coin_admission_profiles
  FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'operator'::app_role));

CREATE POLICY "operators write profiles" ON public.coin_admission_profiles
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'operator'::app_role))
  WITH CHECK (public.has_role(auth.uid(), 'operator'::app_role));

CREATE TRIGGER touch_coin_admission_profiles
  BEFORE UPDATE ON public.coin_admission_profiles
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- 3. Runs
CREATE TABLE public.coin_admission_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  profile_id uuid REFERENCES public.coin_admission_profiles(id) ON DELETE SET NULL,
  profile_name text NOT NULL,
  triggered_by uuid,
  status text NOT NULL DEFAULT 'running',
  progress_total int,
  progress_done int DEFAULT 0,
  symbols_total int,
  approved_n int DEFAULT 0,
  watchlist_n int DEFAULT 0,
  rejected_n int DEFAULT 0,
  error text,
  notes text
);

CREATE INDEX coin_admission_runs_started_at_idx
  ON public.coin_admission_runs(started_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.coin_admission_runs TO authenticated;
GRANT ALL ON public.coin_admission_runs TO service_role;

ALTER TABLE public.coin_admission_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "operators read runs" ON public.coin_admission_runs
  FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'operator'::app_role));

CREATE POLICY "operators write runs" ON public.coin_admission_runs
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'operator'::app_role))
  WITH CHECK (public.has_role(auth.uid(), 'operator'::app_role));

-- 4. Results
CREATE TABLE public.coin_admission_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES public.coin_admission_runs(id) ON DELETE CASCADE,
  symbol text NOT NULL,
  status text NOT NULL,
  score numeric,
  coingecko_id text,
  rank int,
  turnover_24h numeric,
  turnover_7d_median numeric,
  turnover_30d_median numeric,
  open_interest_value numeric,
  spread_bps numeric,
  slippage_bps_est numeric,
  listing_age_days int,
  funding_rate numeric,
  max_1h_drop_pct numeric,
  wick_risk_score numeric,
  extreme_wick_count int,
  components jsonb,
  kill_rules_triggered text[],
  fetch_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(run_id, symbol)
);

CREATE INDEX coin_admission_results_run_id_idx ON public.coin_admission_results(run_id);
CREATE INDEX coin_admission_results_symbol_idx ON public.coin_admission_results(symbol);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.coin_admission_results TO authenticated;
GRANT ALL ON public.coin_admission_results TO service_role;

ALTER TABLE public.coin_admission_results ENABLE ROW LEVEL SECURITY;

CREATE POLICY "operators read results" ON public.coin_admission_results
  FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'operator'::app_role));

CREATE POLICY "operators write results" ON public.coin_admission_results
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'operator'::app_role))
  WITH CHECK (public.has_role(auth.uid(), 'operator'::app_role));

-- =====================================================
-- Seed profiles
-- =====================================================

INSERT INTO public.coin_admission_profiles (name, description, thresholds, weights) VALUES
(
  'conservative',
  'Konservativ admission — krever store, etablerte coins med dyp likviditet og lite wick-risiko.',
  jsonb_build_object(
    'max_rank', 100,
    'min_turnover_24h_usd', 100000000,
    'min_turnover_7d_median_usd', 50000000,
    'min_open_interest_value_usd', 50000000,
    'min_listing_age_days', 60,
    'max_spread_bps', 3,
    'max_slippage_bps', 5,
    'max_funding_abs', 0.0005,
    'max_1h_drop_pct_30d', 25,
    'order_size_usd_for_slippage', 5000,
    'approved_min_score', 80,
    'watchlist_min_score', 65
  ),
  jsonb_build_object(
    'rank', 0.25,
    'turnover', 0.20,
    'open_interest', 0.15,
    'depth_slippage', 0.15,
    'listing_age', 0.10,
    'wick_volatility', 0.10,
    'funding_normality', 0.05
  )
),
(
  'aggressive',
  'Aggressiv admission — slipper inn mindre coins, men beholder kill rules for de groveste tilfellene.',
  jsonb_build_object(
    'max_rank', 200,
    'min_turnover_24h_usd', 50000000,
    'min_turnover_7d_median_usd', 25000000,
    'min_open_interest_value_usd', 20000000,
    'min_listing_age_days', 30,
    'max_spread_bps', 5,
    'max_slippage_bps', 10,
    'max_funding_abs', 0.001,
    'max_1h_drop_pct_30d', 35,
    'order_size_usd_for_slippage', 5000,
    'approved_min_score', 80,
    'watchlist_min_score', 65
  ),
  jsonb_build_object(
    'rank', 0.25,
    'turnover', 0.20,
    'open_interest', 0.15,
    'depth_slippage', 0.15,
    'listing_age', 0.10,
    'wick_volatility', 0.10,
    'funding_normality', 0.05
  )
);

-- =====================================================
-- Seed CoinGecko mapping (most common Bybit perps)
-- =====================================================

INSERT INTO public.coin_admission_coingecko_map (bybit_symbol, coingecko_id) VALUES
  ('BTCUSDT','bitcoin'),
  ('ETHUSDT','ethereum'),
  ('SOLUSDT','solana'),
  ('BNBUSDT','binancecoin'),
  ('XRPUSDT','ripple'),
  ('ADAUSDT','cardano'),
  ('DOGEUSDT','dogecoin'),
  ('AVAXUSDT','avalanche-2'),
  ('DOTUSDT','polkadot'),
  ('LINKUSDT','chainlink'),
  ('MATICUSDT','matic-network'),
  ('LTCUSDT','litecoin'),
  ('TRXUSDT','tron'),
  ('ATOMUSDT','cosmos'),
  ('NEARUSDT','near'),
  ('ARBUSDT','arbitrum'),
  ('OPUSDT','optimism'),
  ('APTUSDT','aptos'),
  ('SUIUSDT','sui'),
  ('INJUSDT','injective-protocol'),
  ('TIAUSDT','celestia'),
  ('SEIUSDT','sei-network'),
  ('FILUSDT','filecoin'),
  ('ICPUSDT','internet-computer'),
  ('ETCUSDT','ethereum-classic'),
  ('BCHUSDT','bitcoin-cash'),
  ('XLMUSDT','stellar'),
  ('HBARUSDT','hedera-hashgraph'),
  ('VETUSDT','vechain'),
  ('RNDRUSDT','render-token'),
  ('IMXUSDT','immutable-x'),
  ('AAVEUSDT','aave'),
  ('MKRUSDT','maker'),
  ('UNIUSDT','uniswap'),
  ('LDOUSDT','lido-dao'),
  ('SNXUSDT','havven'),
  ('CRVUSDT','curve-dao-token'),
  ('COMPUSDT','compound-governance-token'),
  ('JUPUSDT','jupiter-exchange-solana'),
  ('PYTHUSDT','pyth-network'),
  ('WIFUSDT','dogwifcoin'),
  ('BONKUSDT','bonk'),
  ('PEPEUSDT','pepe'),
  ('SHIBUSDT','shiba-inu'),
  ('FLOKIUSDT','floki'),
  ('ONDOUSDT','ondo-finance'),
  ('JTOUSDT','jito-governance-token'),
  ('STRKUSDT','starknet'),
  ('WLDUSDT','worldcoin-wld'),
  ('FTMUSDT','fantom');
