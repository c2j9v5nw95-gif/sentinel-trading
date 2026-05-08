
-- 1. Enum
DO $$ BEGIN
  CREATE TYPE public.execution_mode AS ENUM ('live', 'paper');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 2. app_settings
ALTER TABLE public.app_settings
  ADD COLUMN IF NOT EXISTS paper_mode_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS paper_starting_balance_usdt numeric NOT NULL DEFAULT 10000,
  ADD COLUMN IF NOT EXISTS paper_fee_bps numeric NOT NULL DEFAULT 5.5,
  ADD COLUMN IF NOT EXISTS paper_slippage_bps numeric NOT NULL DEFAULT 2,
  ADD COLUMN IF NOT EXISTS paper_fill_latency_ms integer NOT NULL DEFAULT 250;

-- 3. symbols override
ALTER TABLE public.symbols
  ADD COLUMN IF NOT EXISTS execution_mode_override public.execution_mode;

-- 4. orders + positions stamp
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS execution_mode public.execution_mode NOT NULL DEFAULT 'paper';
ALTER TABLE public.positions
  ADD COLUMN IF NOT EXISTS execution_mode public.execution_mode NOT NULL DEFAULT 'paper';

CREATE INDEX IF NOT EXISTS idx_orders_mode_status ON public.orders (execution_mode, status);
CREATE INDEX IF NOT EXISTS idx_positions_mode_closed ON public.positions (execution_mode, closed_at);

-- 5. paper_wallet (singleton, enforced by unique partial index)
CREATE TABLE IF NOT EXISTS public.paper_wallet (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  singleton boolean NOT NULL DEFAULT true,
  balance_usdt numeric NOT NULL DEFAULT 10000,
  equity_usdt numeric NOT NULL DEFAULT 10000,
  realized_pnl numeric NOT NULL DEFAULT 0,
  unrealized_pnl numeric NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT paper_wallet_singleton_chk CHECK (singleton = true)
);
CREATE UNIQUE INDEX IF NOT EXISTS paper_wallet_singleton_uniq ON public.paper_wallet (singleton);

ALTER TABLE public.paper_wallet ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "operator manages paper_wallet" ON public.paper_wallet;
CREATE POLICY "operator manages paper_wallet" ON public.paper_wallet
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'operator'))
  WITH CHECK (public.has_role(auth.uid(), 'operator'));

INSERT INTO public.paper_wallet (singleton) VALUES (true) ON CONFLICT DO NOTHING;

-- 6. paper_market_prices (latest price per symbol)
CREATE TABLE IF NOT EXISTS public.paper_market_prices (
  symbol text PRIMARY KEY,
  price numeric NOT NULL,
  source text NOT NULL DEFAULT 'unknown',
  received_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.paper_market_prices ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "operator reads paper_market_prices" ON public.paper_market_prices;
CREATE POLICY "operator reads paper_market_prices" ON public.paper_market_prices
  FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'operator'));
