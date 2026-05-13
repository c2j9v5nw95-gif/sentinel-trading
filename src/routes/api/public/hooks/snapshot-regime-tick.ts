// POST /api/public/hooks/snapshot-regime-tick
// Manual / scheduled regime writer — read-only. Auth via apikey header.

import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { snapshotRegimeTick } from '@/lib/analytics/snapshot-regime.server';

const Body = z.object({
  schedule: z.enum(['trade', 'context', 'manual']),
  symbols: z.array(z.string().min(1).max(40)).max(60).optional(),
  timeframes: z.array(z.string().min(1).max(8)).max(9).optional(),
  dry_run: z.boolean().optional(),
});

function authOk(req: Request): boolean {
  const expected = process.env.SUPABASE_ANON_KEY ?? process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!expected) return false;
  const got = req.headers.get('apikey') ?? req.headers.get('x-api-key');
  return !!got && got === expected;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

export const Route = createFileRoute('/api/public/hooks/snapshot-regime-tick')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!authOk(request)) return json({ error: 'unauthorized' }, 401);
        let raw: unknown;
        try { raw = await request.json(); } catch { return json({ error: 'bad_json' }, 400); }
        const parsed = Body.safeParse(raw);
        if (!parsed.success) return json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
        const r = await snapshotRegimeTick(parsed.data);
        const status = r.error === 'universe_too_large' || r.error === 'manual_requires_timeframes' || r.error === 'no_valid_timeframes'
          ? 400 : 200;
        return json(r, status);
      },
    },
  },
});
