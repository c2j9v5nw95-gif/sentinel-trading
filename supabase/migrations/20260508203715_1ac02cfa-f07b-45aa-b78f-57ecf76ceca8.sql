ALTER TABLE public.app_settings
  ADD COLUMN IF NOT EXISTS emergency_stop_blocks_exits boolean NOT NULL DEFAULT false;

ALTER TABLE public.signals
  ADD COLUMN IF NOT EXISTS replay_of uuid NULL,
  ADD COLUMN IF NOT EXISTS replay_by uuid NULL,
  ADD COLUMN IF NOT EXISTS replay_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS bypass_dedupe boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS retry_count int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS error_stack text NULL,
  ADD COLUMN IF NOT EXISTS request_id text NULL,
  ADD COLUMN IF NOT EXISTS decision_trail jsonb NOT NULL DEFAULT '[]'::jsonb;

CREATE INDEX IF NOT EXISTS idx_signals_status_active
  ON public.signals (status)
  WHERE status IN ('queued','processing','dead_letter');

CREATE INDEX IF NOT EXISTS idx_signals_replay_of ON public.signals(replay_of);

CREATE OR REPLACE FUNCTION public.replay_signal(_signal_id uuid, _bypass_dedupe boolean)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  src public.signals%ROWTYPE;
  new_id uuid;
  new_dedupe text;
BEGIN
  IF NOT public.has_role(auth.uid(), 'operator'::app_role) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  SELECT * INTO src FROM public.signals WHERE id = _signal_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'signal not found';
  END IF;

  new_id := gen_random_uuid();
  new_dedupe := src.dedupe_key || '|replay=' || new_id::text;

  INSERT INTO public.signals (
    id, transport, type, action, symbol, strategy, tag,
    strategy_code, entry_reason, exit_reason, portion, bar_time,
    payload, dedupe_key, status,
    replay_of, replay_by, replay_at, bypass_dedupe, request_id
  ) VALUES (
    new_id, src.transport, src.type, src.action, src.symbol, src.strategy, src.tag,
    src.strategy_code, src.entry_reason, src.exit_reason, src.portion, src.bar_time,
    src.payload, new_dedupe, 'queued',
    src.id, auth.uid(), now(), COALESCE(_bypass_dedupe, false), src.request_id
  );

  INSERT INTO public.audit_log (actor_user_id, action, target, after)
  VALUES (auth.uid(), 'signal_replayed', new_id::text,
          jsonb_build_object('replay_of', src.id, 'bypass_dedupe', COALESCE(_bypass_dedupe,false)));

  RETURN new_id;
END;
$$;

REVOKE ALL ON FUNCTION public.replay_signal(uuid, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.replay_signal(uuid, boolean) TO authenticated;