-- Enable pg_net for async outbound HTTP from triggers
CREATE EXTENSION IF NOT EXISTS pg_net;

-- Server-only secret store; no RLS policies => no client access
CREATE TABLE IF NOT EXISTS public.internal_hook_config (
  name text PRIMARY KEY,
  value text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.internal_hook_config ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.internal_hook_config FROM anon, authenticated;

-- Config columns on app_settings (URL is non-sensitive; secret is NOT stored here)
ALTER TABLE public.app_settings
  ADD COLUMN IF NOT EXISTS auto_snapshot_signal_context_enabled boolean NOT NULL DEFAULT true;
ALTER TABLE public.app_settings
  ADD COLUMN IF NOT EXISTS snapshot_signal_context_url text;

-- Trigger function: trade-only, fire-and-forget, never blocks insert
CREATE OR REPLACE FUNCTION public.trigger_snapshot_signal_context()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  cfg public.app_settings%ROWTYPE;
  hook_secret text;
BEGIN
  IF NEW.type <> 'trade' THEN
    RETURN NEW;
  END IF;

  SELECT * INTO cfg FROM public.app_settings WHERE singleton = true;
  IF NOT cfg.auto_snapshot_signal_context_enabled
     OR cfg.snapshot_signal_context_url IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT value INTO hook_secret
  FROM public.internal_hook_config
  WHERE name = 'snapshot_hook_secret';
  IF hook_secret IS NULL THEN
    RETURN NEW;
  END IF;

  BEGIN
    PERFORM net.http_post(
      url     := cfg.snapshot_signal_context_url,
      headers := jsonb_build_object(
                   'Content-Type', 'application/json',
                   'X-Snapshot-Hook-Secret', hook_secret),
      body    := jsonb_build_object('signal_id', NEW.id),
      timeout_milliseconds := 5000
    );
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO public.error_log(source, message, context)
    VALUES (
      'trigger_snapshot_signal_context',
      SQLERRM,
      jsonb_build_object('signal_id', NEW.id, 'sqlstate', SQLSTATE)
    );
  END;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_signals_auto_snapshot ON public.signals;
CREATE TRIGGER trg_signals_auto_snapshot
AFTER INSERT ON public.signals
FOR EACH ROW
EXECUTE FUNCTION public.trigger_snapshot_signal_context();