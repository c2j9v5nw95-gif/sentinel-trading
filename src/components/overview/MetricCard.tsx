import type { ReactNode } from "react";

interface Props {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  right?: ReactNode;
  tone?: "default" | "success" | "danger" | "warning";
}

export function MetricCard({ label, value, sub, right, tone = "default" }: Props) {
  const valueTone =
    tone === "success" ? "text-success"
      : tone === "danger" ? "text-danger"
      : tone === "warning" ? "text-warning"
      : "text-foreground";
  return (
    <div className="flex h-full flex-col rounded-lg border border-border bg-card p-4 shadow-sm">
      <div className="flex items-start justify-between gap-2">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          {label}
        </div>
        {right}
      </div>
      <div className={`mt-2 text-2xl font-semibold tabular ${valueTone}`}>{value}</div>
      {sub && <div className="mt-1 text-xs text-muted-foreground tabular">{sub}</div>}
    </div>
  );
}
