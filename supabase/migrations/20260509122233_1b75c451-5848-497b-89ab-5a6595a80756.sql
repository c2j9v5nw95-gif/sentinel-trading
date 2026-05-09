CREATE TABLE IF NOT EXISTS public.bybit_request_traces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  label text NOT NULL,
  mode text,
  signal_id uuid,
  base_url text NOT NULL,
  endpoint text NOT NULL,
  method text NOT NULL,
  query jsonb,
  query_string text,
  body_keys jsonb,
  body_size integer,
  body_sha256_prefix text,
  recv_window_ms integer,
  timestamp_ms bigint,
  sign_payload_prefix text,
  sign_len integer,
  api_key_prefix text,
  idempotency_key text,
  attempt integer,
  http_status integer,
  content_type text,
  cf_ray text,
  server text,
  bapi_request_id text,
  amz_cf_id text,
  amz_cf_pop text,
  via text,
  ret_code integer,
  ret_msg text,
  body_snippet text,
  duration_ms integer,
  ok boolean NOT NULL DEFAULT false,
  error_kind text
);

CREATE INDEX IF NOT EXISTS idx_bybit_traces_created_at ON public.bybit_request_traces (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bybit_traces_signal_id ON public.bybit_request_traces (signal_id) WHERE signal_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_bybit_traces_endpoint_created ON public.bybit_request_traces (endpoint, created_at DESC);

ALTER TABLE public.bybit_request_traces ENABLE ROW LEVEL SECURITY;

CREATE POLICY "operator reads bybit_request_traces"
  ON public.bybit_request_traces
  FOR SELECT
  TO authenticated
  USING (public.has_role(auth.uid(), 'operator'::app_role));