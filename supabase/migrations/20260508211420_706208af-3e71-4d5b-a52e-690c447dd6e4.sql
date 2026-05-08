
ALTER TABLE public.app_settings
  ADD COLUMN IF NOT EXISTS chaos_config jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS public.scenario_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  preset text NOT NULL,
  symbol text NOT NULL,
  status text NOT NULL DEFAULT 'running',
  steps jsonb NOT NULL DEFAULT '[]'::jsonb,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  created_by uuid
);

ALTER TABLE public.scenario_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "operator reads scenario_runs" ON public.scenario_runs
  FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'operator'::app_role));

CREATE POLICY "operator manages scenario_runs" ON public.scenario_runs
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'operator'::app_role))
  WITH CHECK (public.has_role(auth.uid(), 'operator'::app_role));
