
CREATE TABLE public.sizing_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  priority integer NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  label text NOT NULL,
  condition jsonb NOT NULL DEFAULT '{}'::jsonb,
  action jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.sizing_rules ENABLE ROW LEVEL SECURITY;

CREATE POLICY "operator manages sizing_rules"
  ON public.sizing_rules FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'operator'::app_role))
  WITH CHECK (public.has_role(auth.uid(), 'operator'::app_role));

CREATE TRIGGER trg_sizing_rules_touch
  BEFORE UPDATE ON public.sizing_rules
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

CREATE INDEX sizing_rules_priority_idx ON public.sizing_rules(priority) WHERE enabled = true;

CREATE TABLE public.symbol_strategy_overrides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  symbol text NOT NULL,
  strategy text NOT NULL,
  tag text NOT NULL DEFAULT '',
  account_balance_percent numeric,
  leverage numeric,
  position_size_multiplier numeric,
  max_position_notional_usdt numeric,
  max_margin_usage_usdt numeric,
  force_state text CHECK (force_state IN ('block','allow')),
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (symbol, strategy, tag)
);

ALTER TABLE public.symbol_strategy_overrides ENABLE ROW LEVEL SECURITY;

CREATE POLICY "operator manages symbol_strategy_overrides"
  ON public.symbol_strategy_overrides FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'operator'::app_role))
  WITH CHECK (public.has_role(auth.uid(), 'operator'::app_role));

CREATE TRIGGER trg_symbol_strategy_overrides_touch
  BEFORE UPDATE ON public.symbol_strategy_overrides
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- Seed default rules (priority 10 = highest, evaluated first)
INSERT INTO public.sizing_rules (priority, enabled, label, condition, action) VALUES
  (10, true, 'Block if net profit ≤ 0',
    '{"all":[{"metric":"net_profit","op":"<=","value":0}]}'::jsonb,
    '{"block":true}'::jsonb),
  (20, true, 'High winrate (≥70%) → 15% equity',
    '{"all":[{"metric":"winrate","op":">=","value":70}]}'::jsonb,
    '{"set":{"account_balance_percent":15}}'::jsonb),
  (30, true, 'Medium winrate (≥55%) → 5% equity',
    '{"all":[{"metric":"winrate","op":">=","value":55}]}'::jsonb,
    '{"set":{"account_balance_percent":5}}'::jsonb);
