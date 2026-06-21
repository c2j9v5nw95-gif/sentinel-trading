CREATE OR REPLACE FUNCTION public.equity_snapshots_bucketed(
  _source text,
  _since timestamptz,
  _buckets int DEFAULT 200
)
RETURNS TABLE(captured_at timestamptz, total_equity numeric)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH params AS (
    SELECT
      GREATEST(_buckets, 1) AS buckets,
      _since AS since_ts,
      now() AS now_ts
  ),
  bucketed AS (
    SELECT
      b.captured_at,
      b.total_equity,
      width_bucket(
        EXTRACT(EPOCH FROM b.captured_at),
        EXTRACT(EPOCH FROM (SELECT since_ts FROM params)),
        EXTRACT(EPOCH FROM (SELECT now_ts FROM params)),
        (SELECT buckets FROM params)
      ) AS bucket
    FROM public.balance_snapshots b
    WHERE b.source = _source
      AND b.captured_at >= _since
      AND b.total_equity IS NOT NULL
  )
  SELECT DISTINCT ON (bucket) captured_at, total_equity
  FROM bucketed
  ORDER BY bucket, captured_at DESC;
$$;

GRANT EXECUTE ON FUNCTION public.equity_snapshots_bucketed(text, timestamptz, int) TO authenticated, service_role;