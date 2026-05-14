// POST /api/public/hooks/snapshot-signal-context
// Internal analytics writer hook. Auth via X-Snapshot-Hook-Secret header.
// Called by the AFTER INSERT DB trigger on public.signals (and operator curl).
// NOT callable from the browser.

import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { timingSafeEqual } from 'crypto';
import { snapshotSignalContext } from '@/lib/analytics/snapshot-signal-context.server';

const Body = z.object({ signal_id: z.string().uuid() });

function authOk(req: Request): boolean {
  const expected = process.env.SNAPSHOT_HOOK_SECRET;
  if (!expected) return false;
  const got = req.headers.get('x-snapshot-hook-secret');
  if (!got || got.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(got), Buffer.from(expected));
  } catch {
    return false;
  }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

export const Route = createFileRoute('/api/public/hooks/snapshot-signal-context')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!process.env.SNAPSHOT_HOOK_SECRET) return json({ error: 'unconfigured' }, 503);
        if (!authOk(request)) return json({ error: 'unauthorized' }, 401);
        let raw: unknown;
        try { raw = await request.json(); } catch { return json({ error: 'bad_json' }, 400); }
        const parsed = Body.safeParse(raw);
        if (!parsed.success) return json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
        const r = await snapshotSignalContext(parsed.data.signal_id);
        return json(r, 200);
      },
    },
  },
});
