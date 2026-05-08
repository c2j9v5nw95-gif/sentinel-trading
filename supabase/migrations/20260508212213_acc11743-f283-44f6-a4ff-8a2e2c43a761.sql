
-- Invariant violation severities reuse existing alert_severity enum if present, else create
DO $$ BEGIN
  CREATE TYPE public.invariant_severity AS ENUM ('info','warning','critical');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Each invariant scan run with a computed health score (0..100)
CREATE TABLE IF NOT EXISTS public.invariant_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  checks_total int NOT NULL DEFAULT 0,
  checks_failed int NOT NULL DEFAULT 0,
  critical_count int NOT NULL DEFAULT 0,
  warning_count int NOT NULL DEFAULT 0,
  health_score int NOT NULL DEFAULT 100,
  auto_paused boolean NOT NULL DEFAULT false,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb
);
ALTER TABLE public.invariant_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "operator reads invariant_runs" ON public.invariant_runs
  FOR SELECT TO authenticated USING (has_role(auth.uid(), 'operator'::app_role));

-- One row per (rule_code, target_key) currently violating; resolved_at set when fixed
CREATE TABLE IF NOT EXISTS public.invariant_violations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_code text NOT NULL,
  rule_label text NOT NULL,
  severity public.invariant_severity NOT NULL DEFAULT 'warning',
  target_kind text NOT NULL,            -- 'position' | 'symbol' | 'lock' | 'system'
  target_key text NOT NULL,             -- id or 'GLOBAL'
  message text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  occurrences int NOT NULL DEFAULT 1,
  resolved_at timestamptz,
  acknowledged_at timestamptz,
  acknowledged_by uuid,
  ack_note text,
  run_id uuid REFERENCES public.invariant_runs(id) ON DELETE SET NULL,
  UNIQUE (rule_code, target_key, resolved_at)
);
ALTER TABLE public.invariant_violations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "operator reads invariant_violations" ON public.invariant_violations
  FOR SELECT TO authenticated USING (has_role(auth.uid(), 'operator'::app_role));
CREATE POLICY "operator updates invariant_violations" ON public.invariant_violations
  FOR UPDATE TO authenticated
  USING (has_role(auth.uid(), 'operator'::app_role))
  WITH CHECK (has_role(auth.uid(), 'operator'::app_role));

CREATE INDEX IF NOT EXISTS idx_inv_viol_open ON public.invariant_violations (rule_code, target_key) WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_inv_viol_recent ON public.invariant_violations (last_seen_at DESC);

-- App setting: auto-pause entries when a critical invariant fires
ALTER TABLE public.app_settings
  ADD COLUMN IF NOT EXISTS auto_pause_on_critical_invariant boolean NOT NULL DEFAULT false;

-- Acknowledge function (security definer)
CREATE OR REPLACE FUNCTION public.acknowledge_invariant_violation(_id uuid, _note text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.has_role(auth.uid(), 'operator'::app_role) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  UPDATE public.invariant_violations
    SET acknowledged_at = now(),
        acknowledged_by = auth.uid(),
        ack_note = _note
    WHERE id = _id;
  INSERT INTO public.audit_log(actor_user_id, action, target, after)
  VALUES (auth.uid(), 'invariant_acknowledged', _id::text, jsonb_build_object('note', _note));
  RETURN true;
END;
$$;
