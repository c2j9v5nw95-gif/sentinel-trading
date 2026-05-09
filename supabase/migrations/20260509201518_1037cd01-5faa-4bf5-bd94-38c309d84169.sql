
CREATE TABLE public.bridge_smoke_tests (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  checked_at timestamp with time zone NOT NULL DEFAULT now(),
  ok boolean NOT NULL,
  total_ms integer,
  bybit_ms integer,
  http_status integer,
  ret_code integer,
  ret_msg text,
  public_ip text,
  account_equity numeric,
  account_available numeric,
  error text,
  raw jsonb
);

ALTER TABLE public.bridge_smoke_tests ENABLE ROW LEVEL SECURITY;

CREATE POLICY "operator reads bridge_smoke_tests"
  ON public.bridge_smoke_tests
  FOR SELECT
  TO authenticated
  USING (public.has_role(auth.uid(), 'operator'::app_role));

CREATE INDEX idx_bridge_smoke_tests_checked_at
  ON public.bridge_smoke_tests (checked_at DESC);
