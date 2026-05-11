import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { fmtAge } from "./format";

interface Row {
  id: string;
  symbol: string;
  exit_recovery_state: string | null;
  exit_recovery_attempts: number;
  exit_recovery_last_at: string | null;
  exit_recovery_last_error: string | null;
  side: "long" | "short";
  qty_open: number | null;
  execution_mode: string;
}

export function RecoveryAlertBanner() {
  const { data } = useQuery({
    queryKey: ["overview", "recovery_states"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("positions")
        .select(
          "id,symbol,exit_recovery_state,exit_recovery_attempts,exit_recovery_last_at,exit_recovery_last_error,side,qty_open,execution_mode",
        )
        .in("exit_recovery_state", ["pending", "manual_required"])
        .is("closed_at", null);
      if (error) throw error;
      return (data ?? []) as Row[];
    },
    refetchInterval: 5_000,
  });

  const rows = data ?? [];
  if (rows.length === 0) return null;
  const manual = rows.filter((r) => r.exit_recovery_state === "manual_required");
  const pending = rows.filter((r) => r.exit_recovery_state === "pending");
  const critical = manual.length > 0;

  return (
    <div
      className={`rounded-lg border p-4 ${
        critical
          ? "border-danger/50 bg-danger/10"
          : "border-warning/50 bg-warning/10"
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <div
            className={`text-sm font-bold uppercase tracking-wider ${
              critical ? "text-danger" : "text-warning"
            }`}
          >
            ● {critical ? "Manual intervention required" : "Exit recovery in progress"}
          </div>
          <div className="mt-0.5 text-xs text-muted-foreground">
            {manual.length > 0 && (
              <span>
                {manual.length} position{manual.length === 1 ? "" : "s"} require operator action
              </span>
            )}
            {manual.length > 0 && pending.length > 0 && <span> · </span>}
            {pending.length > 0 && (
              <span>
                {pending.length} pending recovery attempt{pending.length === 1 ? "" : "s"}
              </span>
            )}
          </div>
        </div>
        <Link
          to="/positions"
          className="rounded border border-border bg-card px-3 py-1.5 text-xs font-medium hover:bg-accent"
        >
          Open positions →
        </Link>
      </div>
      <ul className="mt-3 space-y-1.5">
        {rows.map((r) => (
          <li
            key={r.id}
            className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded border border-border/50 bg-background/30 px-3 py-2 text-xs tabular"
          >
            <span
              className={`rounded px-1.5 py-0.5 text-[10px] font-bold uppercase ${
                r.exit_recovery_state === "manual_required"
                  ? "bg-danger/20 text-danger"
                  : "bg-warning/20 text-warning"
              }`}
            >
              {r.exit_recovery_state}
            </span>
            <span className="font-semibold text-foreground">{r.symbol}</span>
            <span className="text-muted-foreground">{r.side} · {r.qty_open ?? "—"}</span>
            <span className="text-muted-foreground">attempts: {r.exit_recovery_attempts}</span>
            <span className="text-muted-foreground">{fmtAge(r.exit_recovery_last_at)}</span>
            {r.exit_recovery_last_error && (
              <span className="ml-auto truncate text-danger" title={r.exit_recovery_last_error}>
                {r.exit_recovery_last_error}
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
