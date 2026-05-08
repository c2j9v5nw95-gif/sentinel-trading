import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { PageHeader, Card, EmptyState } from "@/components/PageHeader";

export const Route = createFileRoute("/_app/overview")({
  component: Overview,
});

function Overview() {
  const { data } = useQuery({
    queryKey: ["overview"],
    queryFn: async () => {
      const [pos, sigs, alerts] = await Promise.all([
        supabase
          .from("positions")
          .select("id, symbol, side, protection_state, qty_open")
          .is("closed_at", null),
        supabase
          .from("signals")
          .select("id, symbol, action, status, created_at, strategy")
          .order("created_at", { ascending: false })
          .limit(10),
        supabase
          .from("system_alerts")
          .select("id, severity, category, message, created_at")
          .eq("severity", "critical")
          .is("acknowledged_at", null)
          .order("created_at", { ascending: false })
          .limit(5),
      ]);
      return {
        positions: pos.data ?? [],
        signals: sigs.data ?? [],
        alerts: alerts.data ?? [],
      };
    },
    refetchInterval: 5_000,
  });

  const positions = data?.positions ?? [];
  const unprotected = positions.filter((p) => p.protection_state === "unprotected").length;

  return (
    <>
      <PageHeader
        title="Overview"
        description="Operational snapshot of all automated trading activity."
        actions={<EmergencyStopButton />}
      />

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <Card title="Open positions">
          <div className="text-3xl font-semibold tabular">{positions.length}</div>
          <div className="mt-1 text-xs text-muted-foreground">
            {unprotected} unprotected
          </div>
        </Card>
        <Card title="Critical alerts">
          <div className="text-3xl font-semibold tabular text-danger">
            {data?.alerts.length ?? 0}
          </div>
          <div className="mt-1 text-xs text-muted-foreground">unacknowledged</div>
        </Card>
        <Card title="Recent signals">
          <div className="text-3xl font-semibold tabular">
            {data?.signals.length ?? 0}
          </div>
          <div className="mt-1 text-xs text-muted-foreground">in last batch</div>
        </Card>
      </div>

      <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card title="Recent signals">
          {(data?.signals.length ?? 0) === 0 ? (
            <EmptyState title="No signals yet" hint="Awaiting TradingView webhook traffic." />
          ) : (
            <ul className="divide-y divide-border text-sm">
              {data!.signals.map((s) => (
                <li key={s.id} className="flex items-center justify-between py-2 tabular">
                  <span className="font-medium">{s.symbol ?? "—"}</span>
                  <span className="text-muted-foreground">{s.action ?? "—"}</span>
                  <span className="text-xs text-muted-foreground">{s.strategy ?? ""}</span>
                  <span className="text-xs uppercase text-muted-foreground">{s.status}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="Critical alerts">
          {(data?.alerts.length ?? 0) === 0 ? (
            <EmptyState title="All clear" hint="No critical alerts pending." />
          ) : (
            <ul className="divide-y divide-border text-sm">
              {data!.alerts.map((a) => (
                <li key={a.id} className="py-2">
                  <div className="font-medium text-danger">{a.category}</div>
                  <div className="text-xs text-muted-foreground">{a.message}</div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}

function EmergencyStopButton() {
  const [confirmText, setConfirmText] = useState("");
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="rounded-md bg-danger px-4 py-2 text-sm font-semibold text-danger-foreground shadow hover:bg-danger/90"
      >
        EMERGENCY STOP
      </button>
      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-md rounded-lg border border-danger/40 bg-card p-6">
            <h3 className="text-lg font-semibold text-danger">Activate kill switch?</h3>
            <p className="mt-2 text-sm text-muted-foreground">
              This will halt all new entries immediately. Type <b>STOP</b> to confirm.
            </p>
            <input
              autoFocus
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              className="mt-3 w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-danger"
            />
            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={() => {
                  setOpen(false);
                  setConfirmText("");
                }}
                className="rounded-md border border-border px-3 py-1.5 text-sm"
              >
                Cancel
              </button>
              <button
                disabled={confirmText !== "STOP"}
                onClick={async () => {
                  // TODO: call op-emergency-stop edge function
                  setOpen(false);
                  setConfirmText("");
                }}
                className="rounded-md bg-danger px-3 py-1.5 text-sm font-semibold text-danger-foreground disabled:opacity-50"
              >
                Activate
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
