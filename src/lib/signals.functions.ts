import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

const ReplayInput = z.object({
  signalId: z.string().uuid(),
  bypassDedupe: z.boolean().default(false),
});

export const replaySignal = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => ReplayInput.parse(input))
  .handler(async ({ data, context }) => {
    try {
      const { supabase } = context;
      const { data: newId, error } = await supabase.rpc("replay_signal", {
        _signal_id: data.signalId,
        _bypass_dedupe: data.bypassDedupe,
      });
      if (error) throw new Error(error.message ?? JSON.stringify(error));

      // Fire-and-forget dispatch via process-signal edge function.
      const baseUrl = process.env.SUPABASE_URL ?? import.meta.env.VITE_SUPABASE_URL;
      const key = process.env.SUPABASE_PUBLISHABLE_KEY ?? process.env.SUPABASE_ANON_KEY ?? "";
      if (baseUrl) {
        try {
          void fetch(`${baseUrl}/functions/v1/process-signal`, {
            method: "POST",
            headers: { "Content-Type": "application/json", apikey: key, Authorization: `Bearer ${key}` },
            body: JSON.stringify({ signal_id: newId }),
          }).catch(() => { /* cron is the safety net */ });
        } catch { /* ignore dispatch errors — cron is the safety net */ }
      }

      return { signalId: newId as string };
    } catch (err) {
      // Normalize thrown Response (from middleware) or unknown errors into a plain Error
      // so the client doesn't see "[object Response]".
      if (err instanceof Response) {
        const body = await err.text().catch(() => err.statusText);
        throw new Error(`replay_signal failed (${err.status}): ${body || err.statusText}`);
      }
      if (err instanceof Error) throw err;
      throw new Error(typeof err === "string" ? err : JSON.stringify(err));
    }
  });
