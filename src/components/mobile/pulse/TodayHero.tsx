import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Sparkline } from "@/components/overview/Sparkline";
import { fmtNum, fmtSigned, pnlTone } from "@/components/overview/format";

interface OpenPos {
  side: "long" | "short";
  qty_open: number | null;
  entry_price: number | null;
  last_seen_price: number | null;
}

export function TodayHero() {
  const { data: settings } = useQuery({
    queryKey: ["mobile", "settings_hero"],
    queryFn: async () => {
      const { data } = await supabase.from("app_settings").select("live_enabled").maybeSingle();
      return data;
    },
    refetchInterval: 30_000,
  });
  const source = settings?.live_enabled ? "live" : "paper";

  const { data: realized } = useQuery({
    queryKey: ["mobile", "realized_today"],
    queryFn: async () => {
      const start = new Date();
      start.setUTCHours(0, 0, 0, 0);
      const { data } = await supabase
        .from("positions")
        .select("realized_pnl")
        .gte("closed_at", start.toISOString())
        .not("closed_at", "is", null);
      return (data ?? []).reduce((s, r) => s + Number(r.realized_pnl ?? 0), 0);
    },
    refetchInterval: 10_000,
  });

  const { data: open } = useQuery({
    queryKey: ["mobile", "unrealized"],
    queryFn: async () => {
      const { data } = await supabase
        .from("positions")
        .select("side,qty_open,entry_price,last_seen_price")
        .is("closed_at", null);
      return (data ?? []) as OpenPos[];
    },
    refetchInterval: 5_000,
  });

  const { data: equity } = useQuery({
    queryKey: ["mobile", "equity_24h", source],
    queryFn: async () => {
      const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
      const { data } = await supabase
        .from("balance_snapshots")
        .select("captured_at,total_equity")
        .eq("source", source)
        .gte("captured_at", since)
        .order("captured_at", { ascending: true })
        .limit(500);
      return (data ?? []).map((r) => Number(r.total_equity)).filter((n) => Number.isFinite(n));
    },
    refetchInterval: 30_000,
  });

  const upnl = (open ?? []).reduce((s, p) => {
    const q = Number(p.qty_open ?? 0);
    const e = Number(p.entry_price ?? 0);
    const l = Number(p.last_seen_price ?? 0);
    if (!q || !e || !l) return s;
    return s + (l - e) * q * (p.side === "short" ? -1 : 1);
  }, 0);

  const points = equity ?? [];
  const last = points.length ? points[points.length - 1] : null;
  const first = points.length ? points[0] : null;
  const dayPct = last != null && first != null && first !== 0 ? ((last - first) / first) * 100 : null;

  const total = (realized ?? 0) + upnl;

  return (
    <section className="rounded-3xl border border-border/60 bg-gradient-to-br from-card via-card to-card/80 p-5 shadow-sm">
      <div className="flex items-center justify-between">
        <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
          Today
        </div>
        {dayPct != null && (
          <div className={`text-xs font-semibold tabular ${pnlTone(dayPct)}`}>
            {fmtSigned(dayPct)}%
          </div>
        )}
      </div>

      <div className="mt-2 flex items-baseline gap-2">
        <div className={`text-4xl font-semibold tracking-tight tabular ${pnlTone(total)}`}>
          {fmtSigned(total)}
        </div>
        <div className="text-sm text-muted-foreground">USDT</div>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-3">
        <div className="rounded-xl border border-border/40 bg-background/40 p-3">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Realized</div>
          <div className={`mt-1 text-lg font-semibold tabular ${pnlTone(realized ?? 0)}`}>
            {fmtSigned(realized ?? 0)}
          </div>
        </div>
        <div className="rounded-xl border border-border/40 bg-background/40 p-3">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Unrealized</div>
          <div className={`mt-1 text-lg font-semibold tabular ${pnlTone(upnl)}`}>
            {fmtSigned(upnl)}
          </div>
        </div>
      </div>

      <div className="mt-4">
        <Sparkline values={points} width={400} height={48} className="w-full" />
        {last != null && (
          <div className="mt-1 flex justify-between text-[10px] text-muted-foreground">
            <span>Equity 24h · {source}</span>
            <span className="tabular">{fmtNum(last)} USDT</span>
          </div>
        )}
      </div>
    </section>
  );
}
