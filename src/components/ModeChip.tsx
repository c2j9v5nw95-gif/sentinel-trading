export type ExecutionMode = "live" | "paper" | "testnet";

export function ModeChip({ mode }: { mode: ExecutionMode | string | null | undefined }) {
  const m: ExecutionMode = mode === "live" ? "live" : mode === "testnet" ? "testnet" : "paper";
  const cls =
    m === "live"    ? "bg-success/15 text-success border-success/30" :
    m === "testnet" ? "bg-info/15 text-info border-info/30 bg-blue-500/15 text-blue-400 border-blue-500/30" :
                      "bg-warning/15 text-warning border-warning/40";
  return (
    <span
      className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider ${cls}`}
    >
      {m}
    </span>
  );
}
