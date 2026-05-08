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
    const { supabase } = context;
    const { data: newId, error } = await supabase.rpc("replay_signal", {
      _signal_id: data.signalId,
      _bypass_dedupe: data.bypassDedupe,
    });
    if (error) throw new Error(error.message);

    // Fire-and-forget dispatch via process-signal edge function.
    const url = `${import.meta.env.VITE_SUPABASE_URL ?? process.env.SUPABASE_URL}/functions/v1/process-signal`;
    const key = process.env.SUPABASE_PUBLISHABLE_KEY ?? process.env.SUPABASE_ANON_KEY ?? "";
    void fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: key, Authorization: `Bearer ${key}` },
      body: JSON.stringify({ signal_id: newId }),
    }).catch(() => { /* cron is the safety net */ });

    return { signalId: newId as string };
  });
