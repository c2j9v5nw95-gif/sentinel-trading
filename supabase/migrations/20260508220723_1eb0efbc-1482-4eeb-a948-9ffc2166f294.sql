-- 1. Config + halt state on app_settings
ALTER TABLE public.app_settings
  ADD COLUMN IF NOT EXISTS live_risk_max_daily_loss_pct numeric NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS live_risk_max_consecutive_losses integer NOT NULL DEFAULT 4,
  ADD COLUMN IF NOT EXISTS live_risk_max_open_positions integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS live_risk_max_total_exposure_pct numeric NOT NULL DEFAULT 50,
  ADD COLUMN IF NOT EXISTS live_risk_max_unrealized_drawdown_pct numeric NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS live_risk_max_symbol_exposure_pct numeric NOT NULL DEFAULT 30,
  ADD COLUMN IF NOT EXISTS live_risk_halted boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS live_risk_halt_reason text,
  ADD COLUMN IF NOT EXISTS live_risk_halt_metrics jsonb,
  ADD COLUMN IF NOT EXISTS live_risk_halted_at timestamptz,
  ADD COLUMN IF NOT EXISTS live_risk_acknowledged_at timestamptz,
  ADD COLUMN IF NOT EXISTS live_risk_acknowledged_by uuid;

-- 2. Realized PnL on positions
ALTER TABLE public.positions
  ADD COLUMN IF NOT EXISTS realized_pnl numeric NOT NULL DEFAULT 0;

-- 3. Operator acknowledgement RPC
CREATE OR REPLACE FUNCTION public.acknowledge_live_risk_halt(_note text DEFAULT NULL)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.has_role(auth.uid(), 'operator'::app_role) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  UPDATE public.app_settings
    SET live_risk_halted = false,
        live_risk_acknowledged_at = now(),
        live_risk_acknowledged_by = auth.uid()
    WHERE singleton = true;
  INSERT INTO public.audit_log(actor_user_id, action, target, after)
  VALUES (auth.uid(), 'live_risk_halt_acknowledged', 'app_settings',
          jsonb_build_object('note', _note));
  RETURN true;
END;
$$;

-- 4. Internal trigger function — called by monitor (service role)
CREATE OR REPLACE FUNCTION public.trigger_live_risk_halt(_reason text, _metrics jsonb)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE was_halted boolean;
BEGIN
  SELECT live_risk_halted INTO was_halted FROM public.app_settings WHERE singleton = true;
  IF was_halted THEN RETURN false; END IF;

  UPDATE public.app_settings
    SET live_risk_halted = true,
        live_risk_halt_reason = _reason,
        live_risk_halt_metrics = _metrics,
        live_risk_halted_at = now(),
        live_risk_acknowledged_at = NULL,
        live_risk_acknowledged_by = NULL
    WHERE singleton = true;

  INSERT INTO public.system_alerts(severity, category, message, context)
  VALUES ('critical', 'live_risk_halt',
          'LIVE RISK HALTED: ' || _reason,
          _metrics);
  RETURN true;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.trigger_live_risk_halt(text, jsonb) FROM PUBLIC, anon, authenticated;

-- 5. Schedule the monitor every minute
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

DO $$ BEGIN
  PERFORM cron.unschedule('live-risk-monitor');
EXCEPTION WHEN OTHERS THEN NULL; END $$;

SELECT cron.schedule(
  'live-risk-monitor',
  '* * * * *',
  $cron$
  SELECT net.http_post(
    url := 'https://djqhpgbsgelzhrfyxfhl.supabase.co/functions/v1/live-risk-monitor',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRqcWhwZ2JzZ2VsemhyZnl4ZmhsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzgyNjEyNzcsImV4cCI6MjA5MzgzNzI3N30.Aw9kYTn4_F4MINU-X6P1PANjsUL0oSfVK1cb5kX2B5g'
    ),
    body := '{}'::jsonb
  );
  $cron$
);