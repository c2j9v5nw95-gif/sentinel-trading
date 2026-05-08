-- severity enum
DO $$ BEGIN
  CREATE TYPE public.notification_severity AS ENUM ('info','warning','critical');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.notification_status AS ENUM ('sent','skipped','failed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS public.notification_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  singleton boolean NOT NULL DEFAULT true UNIQUE,
  telegram_enabled boolean NOT NULL DEFAULT false,
  enabled_categories jsonb NOT NULL DEFAULT '["live_entry","live_exit","tp_hit","sl_hit","tsl_update","live_risk_halt","invariant_violation","unprotected_position","bybit_diagnostic_failure","dead_letter","emergency_stop"]'::jsonb,
  min_severity public.notification_severity NOT NULL DEFAULT 'warning',
  rate_limit_seconds integer NOT NULL DEFAULT 60,
  dedupe_window_seconds integer NOT NULL DEFAULT 300,
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.notification_settings (singleton)
VALUES (true) ON CONFLICT (singleton) DO NOTHING;

ALTER TABLE public.notification_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "operator manages notification_settings"
  ON public.notification_settings FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'operator'::app_role))
  WITH CHECK (public.has_role(auth.uid(), 'operator'::app_role));

CREATE TRIGGER notification_settings_touch
  BEFORE UPDATE ON public.notification_settings
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

CREATE TABLE IF NOT EXISTS public.notification_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL DEFAULT 'telegram',
  category text NOT NULL,
  severity public.notification_severity NOT NULL,
  dedupe_key text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status public.notification_status NOT NULL,
  error_message text,
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_notification_events_dedupe
  ON public.notification_events (dedupe_key, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notification_events_created
  ON public.notification_events (created_at DESC);

ALTER TABLE public.notification_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "operator reads notification_events"
  ON public.notification_events FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'operator'::app_role));