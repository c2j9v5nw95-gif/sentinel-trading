// POST /api/public/hooks/snapshot-signal-context
// Manual analytics writer — read-only. Auth via apikey header.

import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { snapshotSignalContext } from '@/lib/analytics/snapshot-signal-context.server';

const Body = z.object({ signal_id: z.string().uuid() });

function authOk(req: Request): boolean {
  const expected = process.env.SUPABASE_ANON_KEY ?? process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!expected) return false;
  const got = req.headers.get('apikey') ?? req.headers.get('x-api-key');
  return !!got && got === expected;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

export const Route = createFileRoute('/api/public/hooks/snapshot-signal-context')({
  server: {
    handlers: {
      POST: async ({ request }) => {
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
