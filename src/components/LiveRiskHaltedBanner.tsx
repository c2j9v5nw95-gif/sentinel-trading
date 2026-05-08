import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";

export function LiveRiskHaltedBanner() {
  const qc = useQueryClient();
  const [note, setNote] = useState("");

  const { data } = useQuery({
    queryKey: ["live_risk_halt_state"],
    queryFn: async () => {
      const { data } = await supabase
        .from("app_settings")
        .select("live_risk_halted, live_risk_halt_reason, live_risk_halt_metrics, live_risk_halted_at")
        .maybeSingle();
      return data;
    },
    refetchInterval: 5_000,
  });

  const ack = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.rpc("acknowledge_live_risk_halt", { _note: note || null });
      if (error) throw error;
    },
    onSuccess: () => {
      setNote("");
      qc.invalidateQueries({ queryKey: ["live_risk_halt_state"] });
      qc.invalidateQueries({ queryKey: ["app_settings"] });
    },
  });

  if (!data?.live_risk_halted) return null;

  const metrics = (data.live_risk_halt_metrics ?? {}) as Record<string, unknown>;

  return (
    <div className="border-b-2 border-danger bg-danger/15 px-4 py-2 text-sm">
      <div className="flex flex-wrap items-center gap-3">
        <span className="rounded bg-danger px-2 py-0.5 text-xs font-bold uppercase tracking-wider text-danger-foreground animate-pulse">
          ⛔ LIVE RISK HALTED
        </span>
        <span className="font-medium text-danger">{data.live_risk_halt_reason}</span>
        {data.live_risk_halted_at && (
          <span className="text-xs text-muted-foreground">
            since {new Date(data.live_risk_halted_at).toLocaleString()}
          </span>
        )}
        <span className="ml-auto text-xs text-muted-foreground">
          New live entries blocked · exits remain allowed
        </span>
      </div>
      <details className="mt-1.5">
        <summary className="cursor-pointer text-xs text-muted-foreground">
          Breach metrics
        </summary>
        <div className="mt-1 grid grid-cols-2 gap-x-4 gap-y-0.5 text-xs tabular md:grid-cols-3">
          {Object.entries(metrics)
            .filter(([k]) => k !== "breaches")
            .map(([k, v]) => (
              <div key={k} className="flex justify-between gap-2">
                <span className="text-muted-foreground">{k}</span>
                <span className="font-mono">{String(v)}</span>
              </div>
            ))}
        </div>
      </details>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Acknowledgement note (what was done?)"
          className="flex-1 min-w-[240px] rounded border border-border bg-background px-2 py-1 text-xs"
        />
        <button
          onClick={() => ack.mutate()}
          disabled={ack.isPending}
          className="rounded bg-danger px-3 py-1 text-xs font-semibold text-danger-foreground hover:bg-danger/80 disabled:opacity-50"
        >
          {ack.isPending ? "Acknowledging…" : "Acknowledge & resume entries"}
        </button>
      </div>
    </div>
  );
}
