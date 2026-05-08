CREATE TABLE public.bybit_diagnostics (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mode text NOT NULL,
  ok boolean NOT NULL,
  checks jsonb NOT NULL DEFAULT '{}'::jsonb,
  permissions jsonb,
  account_type text,
  last_response jsonb,
  error_code text,
  error_message text,
  ran_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_bybit_diagnostics_created_at ON public.bybit_diagnostics(created_at DESC);
CREATE INDEX idx_bybit_diagnostics_mode_created ON public.bybit_diagnostics(mode, created_at DESC);

ALTER TABLE public.bybit_diagnostics ENABLE ROW LEVEL SECURITY;

CREATE POLICY "operator reads bybit_diagnostics"
  ON public.bybit_diagnostics FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'operator'::app_role));