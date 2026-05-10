-- Track automatic exit-recovery attempts per position.
-- Used by bybit-reconcile to force reduce-only close when an exit signal failed
-- to actually flatten the position on Bybit.

ALTER TABLE public.positions
  ADD COLUMN IF NOT EXISTS exit_recovery_state text,
  ADD COLUMN IF NOT EXISTS exit_recovery_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS exit_recovery_last_at timestamptz,
  ADD COLUMN IF NOT EXISTS exit_recovery_last_error text,
  ADD COLUMN IF NOT EXISTS exit_recovery_requested_at timestamptz;

-- Allowed values: NULL | 'pending' | 'in_progress' | 'recovered' | 'manual_required'
-- Validation via trigger (CHECK constraints disallowed for forward-compat).
CREATE OR REPLACE FUNCTION public.validate_exit_recovery_state()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.exit_recovery_state IS NOT NULL
     AND NEW.exit_recovery_state NOT IN ('pending','in_progress','recovered','manual_required') THEN
    RAISE EXCEPTION 'invalid exit_recovery_state: %', NEW.exit_recovery_state;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS validate_exit_recovery_state_trg ON public.positions;
CREATE TRIGGER validate_exit_recovery_state_trg
  BEFORE INSERT OR UPDATE ON public.positions
  FOR EACH ROW EXECUTE FUNCTION public.validate_exit_recovery_state();

CREATE INDEX IF NOT EXISTS positions_exit_recovery_open_idx
  ON public.positions (exit_recovery_state)
  WHERE closed_at IS NULL AND exit_recovery_state IN ('pending','in_progress','manual_required');