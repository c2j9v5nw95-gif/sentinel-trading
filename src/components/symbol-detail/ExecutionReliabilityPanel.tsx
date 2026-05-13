import { Card } from "@/components/PageHeader";
import type { SymbolMetrics } from "@/lib/symbol-metrics";
import { fmtNum } from "@/components/overview/format";

export function ExecutionReliabilityPanel({ metrics }: { metrics: SymbolMetrics }) {
  const items = [
    { label: "Signals", value: metrics.signals_total, tone: "default" as const },
    { label: "Rejected", value: metrics.signals_rejected, tone: metrics.signals_rejected > 0 ? "warning" as const : "default" as const },
    { label: "Errors", value: metrics.signals_error, tone: metrics.signals_error > 0 ? "danger" as const : "default" as const },
    {
      label: "Rejection rate",
      value: `${fmtNum(metrics.rejection_rate, 1)}%`,
      tone: metrics.rejection_rate > 30 ? ("danger" as const) : metrics.rejection_rate > 10 ? ("warning" as const) : ("default" as const),
    },
    { label: "Recovery events", value: metrics.recovery_events, tone: metrics.recovery_events > 0 ? "warning" as const : "default" as const },
  ];
  const scores = [
    { label: "Profitability", value: metrics.profitability_score },
    { label: "Signal quality", value: metrics.signal_quality_score },
    { label: "Reliability", value: metrics.reliability_score },
  ];

  return (
    <Card title="Execution reliability">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        {items.map((i) => (
          <div key={i.label} className="rounded border border-border bg-card/40 p-3">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{i.label}</div>
            <div
              className={`mt-1 text-lg font-semibold tabular ${
                i.tone === "danger" ? "text-danger" : i.tone === "warning" ? "text-warning" : "text-foreground"
              }`}
            >
              {i.value}
            </div>
          </div>
        ))}
      </div>
      <div className="mt-3 grid grid-cols-3 gap-3">
        {scores.map((s) => (
          <div key={s.label} className="rounded border border-border bg-card/40 p-3">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
              {s.label} score
            </div>
            <div className="mt-1 text-lg font-semibold tabular text-foreground">
              {s.value != null ? fmtNum(s.value, 0) : "—"}
              <span className="ml-1 text-[10px] text-muted-foreground">/ 100</span>
            </div>
          </div>
        ))}
      </div>
      <p className="mt-2 text-[10px] text-muted-foreground">
        Composite-vekter er enkle proof-of-concept-formler. Justeres når Screener-siden bygges.
      </p>
    </Card>
  );
}
