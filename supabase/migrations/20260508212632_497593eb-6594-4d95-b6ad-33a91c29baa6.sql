
-- Extend execution_mode enum
ALTER TYPE public.execution_mode ADD VALUE IF NOT EXISTS 'testnet';

-- Track whether testnet client is wired up (purely informational)
ALTER TABLE public.app_settings
  ADD COLUMN IF NOT EXISTS testnet_enabled boolean NOT NULL DEFAULT false;

-- Indexes that help reconciliation/recovery scans
CREATE INDEX IF NOT EXISTS idx_positions_open_by_mode
  ON public.positions (execution_mode, symbol)
  WHERE closed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_orders_recent_mode
  ON public.orders (execution_mode, submitted_at DESC);
