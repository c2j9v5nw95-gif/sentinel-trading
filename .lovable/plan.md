## Goal

Let TradingView authenticate against `ingest-webhook` using a `?token=...` query parameter, so you don't have to edit `secret=` into every Pine Script alert string. Payload-secret auth keeps working as a fallback.

## Auth flow (new)

In `supabase/functions/ingest-webhook/index.ts`, before parsing the body:

1. Read `token` from `new URL(req.url).searchParams`.
2. Read `secret=` from the body via existing `extractSecret(bodyText)`.
3. `authOk = expected && (token === expected || providedSecret === expected)`.
4. Priority is informational only (both are accepted). Logged as `auth_method: "url_token" | "payload_secret" | "none"` in the `raw_alerts` insert + abuse-burst context, so you can see in the activity feed which path was used.
5. All existing behavior preserved: malformed/bad_secret logging, 5-in-10-min Telegram burst alert, dedupe, signal insert, async dispatch.

Constant-time compare (avoid timing leaks): wrap the equality check in a small helper that compares byte-by-byte over the full length.

## UI changes — `src/components/WebhookSettingsCard.tsx`

Replace the single "Webhook URL" row with three rows, each with a copy button:

- **TradingView URL (recommended)** — `${SUPABASE_URL}/functions/v1/ingest-webhook?token=<SECRET>`. This is the one to paste into TradingView's webhook field.
- **Webhook URL (no token)** — `${SUPABASE_URL}/functions/v1/ingest-webhook`. For payload-secret mode or manual testing.
- **Webhook URL with token** — same as recommended; shown separately so it's obvious that token is just a query param on the base URL.

Token rendering rules:
- If the operator has just rotated and the plaintext secret is in memory (one-time reveal), inject it into the recommended URL.
- Otherwise show `?token=••••<hint>` (last 4 chars from `app_settings.webhook_secret_hint`) and a "Rotate to reveal" hint. We never persist plaintext, so this matches existing rotate-once behavior.

Update the Pine Script template snippets:
- Keep the existing `secret=...;type=trade;...` template under a "Payload-secret mode (legacy)" subheading.
- Add a new primary "URL-token mode (recommended)" template that omits `secret=`:
  - `type=trade;action=ENTER-LONG;ticker={{ticker}};strategy=EL1;tag=STRAT2`
  - `type=stats;action=HEALTH;ticker={{ticker}};strategy=HEALTH_ALL;trigger=HEARTBEAT;...`
- Short note: "Paste the recommended URL above into TradingView → Notification → Webhook URL. No `secret=` needed in the alert body."

Activity feed: add a small `auth_method` badge (`url_token` / `payload_secret`) next to `auth_status` so you can confirm at a glance which path TradingView is using.

## Schema

No migration needed. `raw_alerts.headers` is already `jsonb`; `auth_method` will live inside an existing context field, or we add a small column `auth_method text` if you want it indexable.

Recommended: add `auth_method text` to `raw_alerts` so the activity feed can render it cleanly without parsing JSON. Migration:
- `alter table public.raw_alerts add column auth_method text;`
- No RLS changes (operator-only read policy already covers it).

## Files touched

- `supabase/functions/ingest-webhook/index.ts` — add URL-token check, log `auth_method`.
- `src/components/WebhookSettingsCard.tsx` — three-URL display + new template, auth_method badge.
- `supabase/migrations/<new>.sql` — add `raw_alerts.auth_method` column.

## Out of scope

- No changes to `op-rotate-webhook-secret` (rotation flow stays one-time-reveal).
- No changes to parser, dedupe, dispatcher, or strategy mapping.
- No change to the actual secret value — same `TRADINGVIEW_WEBHOOK_SECRET` is reused for both auth paths.
