import type { ReactNode } from "react";

export type PillTone = "success" | "warning" | "danger" | "muted";

const TONE: Record<PillTone, string> = {
  success: "border-success/40 bg-success/10 text-success",
  warning: "border-warning/50 bg-warning/15 text-warning",
  danger: "border-danger/50 bg-danger/15 text-danger",
  muted: "border-border bg-muted/40 text-muted-foreground",
};

const DOT: Record<PillTone, string> = {
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-danger animate-pulse",
  muted: "bg-muted-foreground/60",
};

export function StatusPill({
  label,
  tone,
  detail,
}: {
  label: string;
  tone: PillTone;
  detail?: ReactNode;
}) {
  return (
    <div
      className={`flex shrink-0 items-center gap-2 rounded-2xl border px-3 py-2 transition-colors ${TONE[tone]}`}
    >
      <span className={`h-2 w-2 rounded-full ${DOT[tone]}`} />
      <div className="flex flex-col leading-tight">
        <span className="text-[11px] font-bold uppercase tracking-wider">{label}</span>
        {detail && <span className="text-[10px] opacity-80">{detail}</span>}
      </div>
    </div>
  );
}
