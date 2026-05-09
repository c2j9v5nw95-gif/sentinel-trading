
-- Execution bridge: health check log + feature flag.
ALTER TABLE public.app_settings
  ADD COLUMN IF NOT EXISTS use_execution_bridge boolean NOT NULL DEFAULT true;

CREATE TABLE IF NOT EXISTS public.bridge_health_checks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  checked_at timestamptz NOT NULL DEFAULT now(),
  ok boolean NOT NULL,
  latency_ms integer,
  http_status integer,
  bridge_version text,
  public_ip text,
  region text,
  bybit_reachable boolean,
  error text,
  raw jsonb
);

CREATE INDEX IF NOT EXISTS idx_bridge_health_checks_checked_at
  ON public.bridge_health_checks (checked_at DESC);

ALTER TABLE public.bridge_health_checks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "operator reads bridge_health_checks"
  ON public.bridge_health_checks FOR SELECT
  TO authenticated
  USING (public.has_role(auth.uid(), 'operator'::app_role));
