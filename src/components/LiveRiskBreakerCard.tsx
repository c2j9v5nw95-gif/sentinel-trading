import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card } from "@/components/PageHeader";

type Form = {
  live_risk_max_daily_loss_pct: number;
  live_risk_max_consecutive_losses: number;
  live_risk_max_open_positions: number;
  live_risk_max_total_exposure_pct: number;
  live_risk_max_unrealized_drawdown_pct: number;
  live_risk_max_symbol_exposure_pct: number;
};

const FIELDS: { key: keyof Form; label: string; suffix: string; step: number }[] = [
  { key: "live_risk_max_daily_loss_pct", label: "Daily max loss", suffix: "%", step: 0.5 },
  { key: "live_risk_max_consecutive_losses", label: "Consecutive losses", suffix: "trades", step: 1 },
  { key: "live_risk_max_open_positions", label: "Max open positions", suffix: "open", step: 1 },
  { key: "live_risk_max_total_exposure_pct", label: "Max total exposure", suffix: "% of equity", step: 1 },
  { key: "live_risk_max_unrealized_drawdown_pct", label: "Max unrealized drawdown", suffix: "% of equity", step: 0.5 },
  { key: "live_risk_max_symbol_exposure_pct", label: "Max single-symbol exposure", suffix: "% of equity", step: 1 },
];

export function LiveRiskBreakerCard() {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ["app_settings_risk"],
    queryFn: async () => {
      const { data } = await supabase.from("app_settings").select("*").maybeSingle();
      return data;
    },
    refetchInterval: 10_000,
  });

  const [form, setForm] = useState<Form | null>(null);
  useEffect(() => {
    if (data && !form) {
      setForm({
        live_risk_max_daily_loss_pct: Number(data.live_risk_max_daily_loss_pct ?? 5),
        live_risk_max_consecutive_losses: Number(data.live_risk_max_consecutive_losses ?? 4),
        live_risk_max_open_positions: Number(data.live_risk_max_open_positions ?? 1),
        live_risk_max_total_exposure_pct: Number(data.live_risk_max_total_exposure_pct ?? 50),
        live_risk_max_unrealized_drawdown_pct: Number(data.live_risk_max_unrealized_drawdown_pct ?? 5),
        live_risk_max_symbol_exposure_pct: Number(data.live_risk_max_symbol_exposure_pct ?? 30),
      });
    }
  }, [data, form]);

  const save = useMutation({
    mutationFn: async (patch: Form) => {
      if (!data?.id) return;
      const { error } = await supabase.from("app_settings").update(patch).eq("id", data.id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["app_settings_risk"] }),
  });

  return (
    <Card title="Live risk circuit breaker">
      <p className="mb-3 text-xs text-muted-foreground">
        Evaluated every minute against live positions only. Any breach pauses{" "}
        <strong>new live entries</strong> while keeping exits flowing, raises a critical alert,
        and shows the LIVE RISK HALTED banner until an operator acknowledges.
      </p>

      {form && (
        <div className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
          {FIELDS.map((f) => (
            <label key={f.key} className="flex items-center justify-between gap-3 rounded-md border border-border bg-background/40 px-3 py-2">
              <span className="text-xs">{f.label}</span>
              <span className="flex items-center gap-1">
                <input
                  type="number"
                  step={f.step}
                  min={0}
                  value={form[f.key]}
                  onChange={(e) => setForm({ ...form, [f.key]: Number(e.target.value) })}
                  className="w-20 rounded border border-border bg-background px-2 py-0.5 text-right text-xs font-mono"
                />
                <span className="text-xs text-muted-foreground">{f.suffix}</span>
              </span>
            </label>
          ))}
        </div>
      )}

      <div className="mt-3 flex items-center gap-3">
        <button
          onClick={() => form && save.mutate(form)}
          disabled={save.isPending || !form}
          className="rounded-md border border-primary bg-primary/10 px-3 py-1.5 text-xs font-semibold hover:bg-primary/20 disabled:opacity-40"
        >
          {save.isPending ? "Saving…" : "Save thresholds"}
        </button>
        {data?.live_risk_halted ? (
          <span className="text-xs text-danger">⛔ Currently halted — see banner above</span>
        ) : (
          <span className="text-xs text-muted-foreground">
            Status: <span className="text-success">armed</span>
            {data?.live_risk_acknowledged_at && ` · last ack ${new Date(data.live_risk_acknowledged_at).toLocaleString()}`}
          </span>
        )}
      </div>
    </Card>
  );
}
