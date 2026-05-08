
DO $$ BEGIN
  CREATE TYPE public.lock_kind AS ENUM ('entry','exit','replay','reconcile','protect','manual');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS public.execution_locks (
  symbol         text PRIMARY KEY,
  kind           public.lock_kind NOT NULL,
  owner_id       text NOT NULL,
  job_id         uuid,
  signal_id      uuid,
  acquired_at    timestamptz NOT NULL DEFAULT now(),
  heartbeat_at   timestamptz NOT NULL DEFAULT now(),
  ttl_seconds    integer NOT NULL DEFAULT 30,
  metadata       jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS idx_execution_locks_heartbeat ON public.execution_locks (heartbeat_at);

ALTER TABLE public.execution_locks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "operator reads locks" ON public.execution_locks;
CREATE POLICY "operator reads locks" ON public.execution_locks
  FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'operator'));

CREATE TABLE IF NOT EXISTS public.execution_lock_events (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  symbol              text NOT NULL,
  kind                public.lock_kind NOT NULL,
  owner_id            text NOT NULL,
  event               text NOT NULL,
  previous_kind       public.lock_kind,
  previous_owner_id   text,
  note                text,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_lock_events_symbol_time
  ON public.execution_lock_events (symbol, created_at DESC);

ALTER TABLE public.execution_lock_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "operator reads lock events" ON public.execution_lock_events;
CREATE POLICY "operator reads lock events" ON public.execution_lock_events
  FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'operator'));

CREATE OR REPLACE FUNCTION public.lock_can_preempt(_current public.lock_kind, _requested public.lock_kind)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT
    CASE
      WHEN _requested = 'manual' THEN true
      WHEN _requested = 'exit' AND _current IN ('entry','replay','reconcile','protect') THEN true
      ELSE false
    END
$$;

CREATE OR REPLACE FUNCTION public.acquire_execution_lock(
  _symbol text, _kind public.lock_kind, _owner_id text,
  _job_id uuid, _signal_id uuid, _ttl_seconds integer, _allow_preempt boolean
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  existing public.execution_locks%ROWTYPE;
  ttl int := COALESCE(_ttl_seconds, 30);
  is_expired boolean;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('exec_lock:' || _symbol));
  SELECT * INTO existing FROM public.execution_locks WHERE symbol = _symbol;
  is_expired := existing.symbol IS NOT NULL
                AND (existing.heartbeat_at + (existing.ttl_seconds * interval '1 second')) <= now();

  IF existing.symbol IS NULL OR is_expired THEN
    INSERT INTO public.execution_locks (symbol, kind, owner_id, job_id, signal_id, ttl_seconds)
    VALUES (_symbol, _kind, _owner_id, _job_id, _signal_id, ttl)
    ON CONFLICT (symbol) DO UPDATE SET
      kind = EXCLUDED.kind, owner_id = EXCLUDED.owner_id,
      job_id = EXCLUDED.job_id, signal_id = EXCLUDED.signal_id,
      ttl_seconds = EXCLUDED.ttl_seconds,
      acquired_at = now(), heartbeat_at = now();

    INSERT INTO public.execution_lock_events (symbol, kind, owner_id, event, previous_kind, previous_owner_id, note)
    VALUES (_symbol, _kind, _owner_id,
            CASE WHEN existing.symbol IS NULL THEN 'acquired' ELSE 'stolen' END,
            existing.kind, existing.owner_id,
            CASE WHEN existing.symbol IS NULL THEN NULL ELSE 'expired' END);

    RETURN jsonb_build_object('granted', true, 'took_over', existing.symbol IS NOT NULL);
  END IF;

  IF existing.owner_id = _owner_id AND existing.kind = _kind THEN
    UPDATE public.execution_locks SET heartbeat_at = now() WHERE symbol = _symbol;
    RETURN jsonb_build_object('granted', true, 'reentrant', true);
  END IF;

  IF _allow_preempt AND public.lock_can_preempt(existing.kind, _kind) THEN
    UPDATE public.execution_locks SET
      kind = _kind, owner_id = _owner_id, job_id = _job_id, signal_id = _signal_id,
      ttl_seconds = ttl, acquired_at = now(), heartbeat_at = now()
    WHERE symbol = _symbol;

    INSERT INTO public.execution_lock_events (symbol, kind, owner_id, event, previous_kind, previous_owner_id)
    VALUES (_symbol, _kind, _owner_id, 'preempted', existing.kind, existing.owner_id);

    RETURN jsonb_build_object('granted', true, 'preempted', true,
                              'previous_kind', existing.kind,
                              'previous_owner_id', existing.owner_id);
  END IF;

  RETURN jsonb_build_object('granted', false,
                            'holder_kind', existing.kind,
                            'holder_owner_id', existing.owner_id,
                            'expires_at', existing.heartbeat_at + (existing.ttl_seconds * interval '1 second'));
END;
$$;

CREATE OR REPLACE FUNCTION public.heartbeat_execution_lock(_symbol text, _owner_id text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE updated int;
BEGIN
  UPDATE public.execution_locks SET heartbeat_at = now()
  WHERE symbol = _symbol AND owner_id = _owner_id
    AND (heartbeat_at + (ttl_seconds * interval '1 second')) > now();
  GET DIAGNOSTICS updated = ROW_COUNT;
  RETURN updated > 0;
END;
$$;

CREATE OR REPLACE FUNCTION public.release_execution_lock(_symbol text, _owner_id text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE existing public.execution_locks%ROWTYPE;
BEGIN
  SELECT * INTO existing FROM public.execution_locks WHERE symbol = _symbol;
  IF existing.symbol IS NULL OR existing.owner_id <> _owner_id THEN
    RETURN false;
  END IF;
  DELETE FROM public.execution_locks WHERE symbol = _symbol AND owner_id = _owner_id;
  INSERT INTO public.execution_lock_events (symbol, kind, owner_id, event)
  VALUES (_symbol, existing.kind, _owner_id, 'released');
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.expire_stale_locks()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r record; n int := 0;
BEGIN
  FOR r IN
    DELETE FROM public.execution_locks
    WHERE (heartbeat_at + (ttl_seconds * interval '1 second')) <= now()
    RETURNING symbol, kind, owner_id
  LOOP
    INSERT INTO public.execution_lock_events (symbol, kind, owner_id, event, note)
    VALUES (r.symbol, r.kind, r.owner_id, 'expired', 'swept');
    n := n + 1;
  END LOOP;
  RETURN n;
END;
$$;

CREATE OR REPLACE FUNCTION public.steal_execution_lock(_symbol text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE owner_id text;
BEGIN
  IF NOT public.has_role(auth.uid(), 'operator') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  owner_id := 'operator:' || COALESCE(auth.uid()::text, 'unknown');
  RETURN public.acquire_execution_lock(_symbol, 'manual'::public.lock_kind, owner_id, NULL, NULL, 300, true);
END;
$$;

CREATE OR REPLACE VIEW public.current_execution_locks AS
SELECT
  l.symbol, l.kind, l.owner_id, l.job_id, l.signal_id,
  l.acquired_at, l.heartbeat_at, l.ttl_seconds, l.metadata,
  (l.heartbeat_at + (l.ttl_seconds * interval '1 second'))           AS expires_at,
  EXTRACT(EPOCH FROM (now() - l.acquired_at))::int                   AS age_seconds,
  EXTRACT(EPOCH FROM (now() - l.heartbeat_at))::int                  AS heartbeat_age_seconds,
  EXTRACT(EPOCH FROM ((l.heartbeat_at + (l.ttl_seconds * interval '1 second')) - now()))::int AS seconds_until_expiry,
  ((l.heartbeat_at + (l.ttl_seconds * interval '1 second')) <= now()) AS is_stale
FROM public.execution_locks l;

GRANT SELECT ON public.current_execution_locks TO authenticated;

REVOKE ALL ON FUNCTION public.acquire_execution_lock(text, public.lock_kind, text, uuid, uuid, integer, boolean) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.heartbeat_execution_lock(text, text) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.release_execution_lock(text, text) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.expire_stale_locks() FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.steal_execution_lock(text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.steal_execution_lock(text) TO authenticated;
