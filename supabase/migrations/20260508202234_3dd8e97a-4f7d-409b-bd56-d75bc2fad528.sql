ALTER TYPE risk_gate ADD VALUE IF NOT EXISTS 'exposure_limit';

ALTER TABLE public.symbols
  ADD COLUMN max_position_notional_usdt numeric NULL,
  ADD COLUMN max_margin_usage_usdt numeric NULL;

ALTER TABLE public.symbols
  ADD CONSTRAINT symbols_max_notional_positive CHECK (max_position_notional_usdt IS NULL OR max_position_notional_usdt > 0),
  ADD CONSTRAINT symbols_max_margin_positive CHECK (max_margin_usage_usdt IS NULL OR max_margin_usage_usdt > 0);