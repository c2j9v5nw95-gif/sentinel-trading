import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { PageHeader, Card, EmptyState } from "@/components/PageHeader";
import { ModeChip } from "@/components/ModeChip";
import { ExecutionLocksPanel } from "@/components/ExecutionLocksPanel";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export const Route = createFileRoute("/_app/positions")({
  component: PositionsPage,
});

type Position = {
  id: string;
  symbol: string;
  side: "long" | "short";
  qty_open: number | null;
  entry_price: number | null;
  execution_mode: string;
  protection_state: string;
  tp1_done: boolean;
  tp2_done: boolean;
  opened_at: string;
  closed_at: string | null;
  last_seen_price: number | null;
};

function PositionsPage() {
  const qc = useQueryClient();
  const [closing, setClosing] = useState<Position | null>(null);
  const [exitPrice, setExitPrice] = useState("");
  const [note, setNote] = useState("");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const { data } = useQuery({
    queryKey: ["positions"],
    queryFn: async () => {
      const { data } = await supabase
        .from("positions")
        .select("*")
        .order("opened_at", { ascending: false });
      return (data ?? []) as Position[];
    },
    refetchInterval: 5_000,
  });

  const closeMut = useMutation({
    mutationFn: async (args: { id: string; exit_price: number | null; note: string | null }) => {
      const { data, error } = await supabase.rpc("manually_close_position", {
        _position_id: args.id,
        _exit_price: args.exit_price,
        _note: args.note,
      });
      if (error) throw new Error(error.message);
      return data as { ok: boolean; realized_pnl: number; pnl_pct: number | null };
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["positions"] });
      setClosing(null);
      setExitPrice("");
      setNote("");
      setErrorMsg(null);
    },
    onError: (err: unknown) => setErrorMsg(err instanceof Error ? err.message : String(err)),
  });

  const previewPnl = (() => {
    if (!closing || !exitPrice || !closing.entry_price || !closing.qty_open) return null;
    const ep = Number(exitPrice);
    if (!Number.isFinite(ep)) return null;
    const realized = closing.side === "long"
      ? (ep - closing.entry_price) * closing.qty_open
      : (closing.entry_price - ep) * closing.qty_open;
    const pct = closing.entry_price > 0 ? (realized / (closing.entry_price * closing.qty_open)) * 100 : 0;
    return { realized, pct };
  })();

  return (
    <>
      <PageHeader title="Positions" description="Live position state reconciled with Bybit." />
      <Card>
        {(data?.length ?? 0) === 0 ? (
          <EmptyState title="No positions" hint="Open positions will appear here." />
        ) : (
          <table className="w-full text-sm tabular">
            <thead className="text-left text-xs uppercase text-muted-foreground">
              <tr>
                <th className="py-2">Symbol</th>
                <th>Mode</th>
                <th>Side</th>
                <th>Qty</th>
                <th>Entry</th>
                <th>Protection</th>
                <th>TP1</th>
                <th>TP2</th>
                <th>Opened</th>
                <th></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {data!.map((p) => {
                const isOpen = p.closed_at == null;
                return (
                  <tr
                    key={p.id}
                    className={
                      p.execution_mode === "live" && isOpen
                        ? "bg-danger/10 border-l-2 border-danger"
                        : ""
                    }
                  >
                    <td className="py-2 font-medium">{p.symbol}</td>
                    <td><ModeChip mode={p.execution_mode} /></td>
                    <td className={p.side === "long" ? "text-success" : "text-danger"}>
                      {p.side.toUpperCase()}
                    </td>
                    <td>{p.qty_open}</td>
                    <td>{p.entry_price}</td>
                    <td>
                      <span
                        className={
                          p.protection_state === "unprotected"
                            ? "text-danger"
                            : p.protection_state === "sl_and_tsl"
                            ? "text-success"
                            : "text-muted-foreground"
                        }
                      >
                        {p.protection_state}
                      </span>
                    </td>
                    <td>{p.tp1_done ? "✓" : "—"}</td>
                    <td>{p.tp2_done ? "✓" : "—"}</td>
                    <td className="text-xs text-muted-foreground">
                      {new Date(p.opened_at).toLocaleString()}
                    </td>
                    <td>
                      {isOpen && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            setClosing(p);
                            setExitPrice(p.last_seen_price ? String(p.last_seen_price) : "");
                            setNote("");
                            setErrorMsg(null);
                          }}
                        >
                          Mark closed
                        </Button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>
      <div className="mt-4">
        <ExecutionLocksPanel />
      </div>

      <Dialog open={!!closing} onOpenChange={(o) => !o && setClosing(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Mark position as closed</DialogTitle>
            <DialogDescription>
              Use this when the position was closed outside the app (e.g. manually on Bybit).
              Realized PnL will be computed from the exit price you enter.
            </DialogDescription>
          </DialogHeader>
          {closing && (
            <div className="space-y-3 text-sm">
              <div className="rounded-md border border-border bg-muted/30 p-2 text-xs">
                <div><strong>{closing.symbol}</strong> · {closing.side.toUpperCase()} · qty {closing.qty_open} · entry {closing.entry_price}</div>
              </div>
              <div className="space-y-1">
                <Label htmlFor="exit-price">Exit price (USDT)</Label>
                <Input
                  id="exit-price"
                  type="number"
                  step="any"
                  value={exitPrice}
                  onChange={(e) => setExitPrice(e.target.value)}
                  placeholder="e.g. 1.2345"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="close-note">Note (optional)</Label>
                <Input
                  id="close-note"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="e.g. closed manually on Bybit web"
                />
              </div>
              {previewPnl && (
                <div className="rounded-md border border-border bg-background p-2 text-xs">
                  <div className="text-muted-foreground">Computed PnL</div>
                  <div className={"font-mono " + (previewPnl.realized >= 0 ? "text-success" : "text-destructive")}>
                    {previewPnl.realized.toFixed(4)} USDT ({previewPnl.pct.toFixed(2)}%)
                  </div>
                </div>
              )}
              {errorMsg && (
                <div className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
                  {errorMsg}
                </div>
              )}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setClosing(null)}>Cancel</Button>
            <Button
              onClick={() => closing && closeMut.mutate({
                id: closing.id,
                exit_price: exitPrice ? Number(exitPrice) : null,
                note: note || null,
              })}
              disabled={closeMut.isPending}
            >
              {closeMut.isPending ? "Closing…" : "Confirm close"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
