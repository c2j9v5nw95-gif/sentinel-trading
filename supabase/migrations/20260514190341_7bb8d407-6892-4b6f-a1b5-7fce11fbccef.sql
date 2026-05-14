-- Add 'order_submit_failed' to default categories so new installs get it
ALTER TABLE public.notification_settings
  ALTER COLUMN enabled_categories SET DEFAULT
    '["live_entry","live_exit","tp_hit","sl_hit","tsl_update","live_risk_halt","invariant_violation","unprotected_position","bybit_diagnostic_failure","dead_letter","emergency_stop","order_submit_failed"]'::jsonb;

-- Patch the existing singleton row so the new category is enabled immediately
UPDATE public.notification_settings
SET enabled_categories = enabled_categories || '["order_submit_failed"]'::jsonb,
    updated_at = now()
WHERE NOT (enabled_categories @> '["order_submit_failed"]'::jsonb);