// POST /api/public/hooks/setup-snapshot-config
// One-shot operator setup. Auth: X-Snapshot-Hook-Secret (must match SNAPSHOT_HOOK_SECRET).
// - Mirrors SNAPSHOT_HOOK_SECRET into internal_hook_config (DB-only, no client access)
// - Sets app_settings.snapshot_signal_context_url to this server's snapshot-signal-context endpoint
// Idempotent. After this runs, the AFTER INSERT trigger on signals starts firing for trade signals.

import { createFileRoute } from '@tanstack/react-router';
import { timingSafeEqual } from 'crypto';
import { supabaseAdmin } from '@/integrations/supabase/client.server';

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } });

function authOk(req: Request): boolean {
  const expected = process.env.SNAPSHOT_HOOK_SECRET;
  if (!expected) return false;
  const got = req.headers.get('x-snapshot-hook-secret');
  if (!got || got.length !== expected.length) return false;
  try { return timingSafeEqual(Buffer.from(got), Buffer.from(expected)); } catch { return false; }
}

export const Route = createFileRoute('/api/public/hooks/setup-snapshot-config')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const secret = process.env.SNAPSHOT_HOOK_SECRET;
        if (!secret) return json({ error: 'unconfigured' }, 503);
        if (!authOk(request)) return json({ error: 'unauthorized' }, 401);

        let body: { url?: string } = {};
        try { body = await request.json(); } catch { /* optional */ }
        const origin = new URL(request.url).origin;
        const url = body.url ?? `${origin}/api/public/hooks/snapshot-signal-context`;

        const upsert = await supabaseAdmin
          .from('internal_hook_config')
          .upsert({ name: 'snapshot_hook_secret', value: secret, updated_at: new Date().toISOString() },
                  { onConflict: 'name' });
        if (upsert.error) return json({ error: 'db_upsert_failed', detail: upsert.error.message }, 500);

        const upd = await supabaseAdmin
          .from('app_settings')
          .update({ snapshot_signal_context_url: url })
          .eq('singleton', true);
        if (upd.error) return json({ error: 'app_settings_update_failed', detail: upd.error.message }, 500);

        return json({ ok: true, url });
      },
    },
  },
});
