
-- 1. Recreate view with security_invoker so RLS on execution_locks applies to the caller.
DROP VIEW IF EXISTS public.current_execution_locks;
CREATE VIEW public.current_execution_locks
WITH (security_invoker = true) AS
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

-- 2. Pin search_path on the IMMUTABLE helper.
CREATE OR REPLACE FUNCTION public.lock_can_preempt(_current public.lock_kind, _requested public.lock_kind)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT
    CASE
      WHEN _requested = 'manual' THEN true
      WHEN _requested = 'exit' AND _current IN ('entry','replay','reconcile','protect') THEN true
      ELSE false
    END
$$;
