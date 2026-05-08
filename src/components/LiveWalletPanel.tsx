import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

interface LiveWallet {
  ok: boolean;
  account_mode: string;
  total_equity: number;
  available_balance: number;
  unrealized_pnl: number;
  used_margin: number;
  synced_at: string;
}

export function LiveWalletPanel() {
  const { data, error, isLoading, refetch, isFetching } = useQuery({
    queryKey: ["live_wallet"],
    queryFn: async () => {
      const { data, error } = await supabase.functions.invoke<LiveWallet | { error: string; message?: string }>(
        "op-live-wallet",
        { body: {}, method: "POST" },
      );
      if (error) throw error;
      if (data && "error" in data) throw new Error((data as any).message || (data as any).error);
      return data as LiveWallet;
    },
    refetchInterval: 15_000,
  });

  const fmt = (n: number, digits = 2) =>
    Number.isFinite(n) ? n.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits }) : "—";

  return (
    <div className="space-y-2 border-t border-border pt-3">
      <div className="flex items-center justify-between">
        <div className="text-xs font-medium text-foreground">Live Bybit wallet</div>
        <button
          onClick={() => refetch()}
          disabled={isFetching}
          className="rounded border border-border bg-card px-2 py-0.5 text-xs hover:bg-accent"
        >
          {isFetching ? "Syncing…" : "Refresh"}
        </button>
      </div>
      {isLoading && <p className="text-xs text-muted-foreground">Loading live balance…</p>}
      {error && (
        <p className="text-xs text-danger">
          Failed to load live wallet: {(error as Error).message}
        </p>
      )}
      {data && (
        <dl className="grid grid-cols-2 gap-3 text-sm tabular">
          <dt className="text-muted-foreground">Total equity</dt>
          <dd>{fmt(data.total_equity)} USDT</dd>
          <dt className="text-muted-foreground">Available balance</dt>
          <dd>{fmt(data.available_balance)} USDT</dd>
          <dt className="text-muted-foreground">Unrealized PnL</dt>
          <dd className={data.unrealized_pnl >= 0 ? "text-success" : "text-danger"}>
            {fmt(data.unrealized_pnl)} USDT
          </dd>
          <dt className="text-muted-foreground">Used margin</dt>
          <dd>{fmt(data.used_margin)} USDT</dd>
          <dt className="text-muted-foreground">Account mode</dt>
          <dd>{data.account_mode}</dd>
          <dt className="text-muted-foreground">Last sync</dt>
          <dd>{new Date(data.synced_at).toLocaleString()}</dd>
        </dl>
      )}
    </div>
  );
}
