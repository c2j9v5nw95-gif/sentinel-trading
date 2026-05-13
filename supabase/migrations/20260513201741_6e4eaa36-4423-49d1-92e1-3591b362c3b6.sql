
-- ============================================================
-- Phase 1: Analytics snapshot schema (read-only foundation)
-- No writers, no cron, no execution changes.
-- ============================================================

-- ---------- Enums via CHECK constraints (kept as text for flexibility) ----------
-- Allowed timeframe values: '1m','2m','5m','10m','15m','30m','1h','4h','1d'
-- Allowed tf_role values:   'trade','context'
-- Allowed environment:      'paper','testnet','live'
-- Allowed regime_class:     'trending_up','trending_down','ranging','volatile_expansion','volatile_compression'
-- Allowed writer:           'signal_context','regime'

-- ============================================================
-- 1. analytics_tf_context_map
-- ============================================================
CREATE TABLE public.analytics_tf_context_map (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trade_timeframe    text NOT NULL,
  context_timeframe  text NOT NULL,
  enabled            boolean NOT NULL DEFAULT true,
  priority           integer NOT NULL DEFAULT 0,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT analytics_tf_context_map_unique UNIQUE (trade_timeframe, context_timeframe),
  CONSTRAINT analytics_tf_context_map_trade_tf_chk CHECK (
    trade_timeframe IN ('1m','2m','5m','10m','15m','30m','1h','4h','1d')
  ),
  CONSTRAINT analytics_tf_context_map_context_tf_chk CHECK (
    context_timeframe IN ('1m','2m','5m','10m','15m','30m','1h','4h','1d')
  )
);

COMMENT ON TABLE public.analytics_tf_context_map IS
  'Maps each trade timeframe to the higher context timeframes that should be snapshotted alongside it. Used by future analytics-snapshot-signal-context writer.';

CREATE INDEX analytics_tf_context_map_trade_tf_idx
  ON public.analytics_tf_context_map (trade_timeframe)
  WHERE enabled;

ALTER TABLE public.analytics_tf_context_map ENABLE ROW LEVEL SECURITY;

CREATE POLICY "operator manages analytics_tf_context_map"
  ON public.analytics_tf_context_map
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'operator'::app_role))
  WITH CHECK (public.has_role(auth.uid(), 'operator'::app_role));

CREATE TRIGGER analytics_tf_context_map_touch_updated_at
  BEFORE UPDATE ON public.analytics_tf_context_map
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- Seed defaults
INSERT INTO public.analytics_tf_context_map (trade_timeframe, context_timeframe, priority) VALUES
  ('1m',  '5m',  1),
  ('1m',  '15m', 2),
  ('1m',  '1h',  3),
  ('2m',  '10m', 1),
  ('2m',  '30m', 2),
  ('2m',  '1h',  3),
  ('5m',  '15m', 1),
  ('5m',  '1h',  2),
  ('5m',  '4h',  3),
  ('10m', '30m', 1),
  ('10m', '1h',  2),
  ('10m', '4h',  3),
  ('15m', '1h',  1),
  ('15m', '4h',  2),
  ('15m', '1d',  3),
  ('30m', '1h',  1),
  ('30m', '4h',  2),
  ('30m', '1d',  3),
  ('1h',  '4h',  1),
  ('1h',  '1d',  2),
  ('4h',  '1d',  1);

-- ============================================================
-- 2. signal_context_snapshots
-- ============================================================
CREATE TABLE public.signal_context_snapshots (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at    timestamptz NOT NULL DEFAULT now(),
  signal_id     uuid REFERENCES public.signals(id) ON DELETE SET NULL,
  symbol        text NOT NULL,
  strategy      text,
  tag           text DEFAULT '',
  environment   text,
  timeframe     text,
  tf_role       text NOT NULL,
  bar_time      timestamptz,
  payload       jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT signal_context_snapshots_signal_tf_unique UNIQUE (signal_id, timeframe),
  CONSTRAINT signal_context_snapshots_timeframe_chk CHECK (
    timeframe IS NULL OR timeframe IN ('1m','2m','5m','10m','15m','30m','1h','4h','1d')
  ),
  CONSTRAINT signal_context_snapshots_tf_role_chk CHECK (
    tf_role IN ('trade','context')
  ),
  CONSTRAINT signal_context_snapshots_environment_chk CHECK (
    environment IS NULL OR environment IN ('paper','testnet','live')
  )
);

COMMENT ON TABLE public.signal_context_snapshots IS
  'One row per (signal × timeframe). tf_role=trade carries the full payload; tf_role=context carries lightweight regime fields only. Aggregation key: (symbol, strategy, timeframe, environment). Never compare across timeframes without explicit aggregation.';

CREATE INDEX signal_context_snapshots_symbol_tf_created_idx
  ON public.signal_context_snapshots (symbol, timeframe, created_at DESC);

CREATE INDEX signal_context_snapshots_signal_id_idx
  ON public.signal_context_snapshots (signal_id);

CREATE INDEX signal_context_snapshots_strategy_tf_idx
  ON public.signal_context_snapshots (strategy, timeframe, created_at DESC);

ALTER TABLE public.signal_context_snapshots ENABLE ROW LEVEL SECURITY;

CREATE POLICY "operator reads signal_context_snapshots"
  ON public.signal_context_snapshots
  FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'operator'::app_role));

-- ============================================================
-- 3. regime_snapshots
-- ============================================================
CREATE TABLE public.regime_snapshots (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  captured_at   timestamptz NOT NULL DEFAULT now(),
  symbol        text NOT NULL,
  timeframe     text NOT NULL,
  bar_time      timestamptz,
  regime_class  text,
  payload       jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT regime_snapshots_timeframe_chk CHECK (
    timeframe IN ('1m','2m','5m','10m','15m','30m','1h','4h','1d')
  ),
  CONSTRAINT regime_snapshots_regime_class_chk CHECK (
    regime_class IS NULL OR regime_class IN (
      'trending_up','trending_down','ranging','volatile_expansion','volatile_compression'
    )
  )
);

COMMENT ON TABLE public.regime_snapshots IS
  'Periodic lightweight regime snapshot per (symbol × timeframe), independent of signals. Used to track regime evolution over time and backfill context for incoming signals.';

CREATE INDEX regime_snapshots_symbol_tf_captured_idx
  ON public.regime_snapshots (symbol, timeframe, captured_at DESC);

CREATE INDEX regime_snapshots_symbol_tf_bar_idx
  ON public.regime_snapshots (symbol, timeframe, bar_time);

ALTER TABLE public.regime_snapshots ENABLE ROW LEVEL SECURITY;

CREATE POLICY "operator reads regime_snapshots"
  ON public.regime_snapshots
  FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'operator'::app_role));

-- ============================================================
-- 4. analytics_snapshot_runs
-- ============================================================
CREATE TABLE public.analytics_snapshot_runs (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at         timestamptz NOT NULL DEFAULT now(),
  finished_at        timestamptz,
  writer             text NOT NULL,
  symbols_processed  integer NOT NULL DEFAULT 0,
  rows_written       integer NOT NULL DEFAULT 0,
  api_calls          integer NOT NULL DEFAULT 0,
  errors             jsonb NOT NULL DEFAULT '[]'::jsonb,
  ok                 boolean NOT NULL DEFAULT false,
  CONSTRAINT analytics_snapshot_runs_writer_chk CHECK (
    writer IN ('signal_context','regime')
  )
);

COMMENT ON TABLE public.analytics_snapshot_runs IS
  'Observability log for analytics snapshot writers. One row per writer tick.';

CREATE INDEX analytics_snapshot_runs_writer_started_idx
  ON public.analytics_snapshot_runs (writer, started_at DESC);

ALTER TABLE public.analytics_snapshot_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "operator reads analytics_snapshot_runs"
  ON public.analytics_snapshot_runs
  FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'operator'::app_role));
