
ALTER TABLE public.app_settings
  ADD COLUMN IF NOT EXISTS live_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS testnet_validated_at timestamptz,
  ADD COLUMN IF NOT EXISTS live_confirmation_phrase text;

-- Force a sane default: paper on, testnet+live off.
UPDATE public.app_settings
   SET paper_mode_enabled = true,
       testnet_enabled = false,
       live_enabled = false
 WHERE singleton = true;
