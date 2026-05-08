import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { PageHeader, Card, EmptyState } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import {
  LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
} from "recharts";

export const Route = createFileRoute("/_app/simulator")({
  component: SimulatorPage,
});

const ACTIONS = ["ENTER-LONG", "ENTER-SHORT", "EXIT-LONG", "EXIT-SHORT", "HEALTH"] as const;
const PRESETS = [
  { id: "tp1_then_tp2", label: "TP1 then TP2" },
  { id: "sl_after_entry", label: "SL after entry" },
  { id: "opposite_signal_exit", label: "Opposite signal exit" },
  { id: "duplicate_webhook_retry", label: "Duplicate webhook retry" },
  { id: "stale_health", label: "Stale health alert" },
  { id: "transport_mismatch", label: "Transport mismatch" },
  { id: "dead_letter_recovery", label: "Dead-letter recovery" },
  { id: "lock_contention", label: "Lock contention" },
  { id: "reconciliation_drift", label: "Reconciliation drift" },
  { id: "tsl_activation", label: "TSL activation" },
];

function SimulatorPage() {
  return (
    <>
      <PageHeader
        title="Simulator"
        description="Inject synthetic alerts, replay scenarios, stress-test the execution state machine."
      />
      <Tabs defaultValue="inject" className="space-y-4">
        <TabsList>
          <TabsTrigger value="inject">Inject alert</TabsTrigger>
          <TabsTrigger value="scenarios">Scenarios</TabsTrigger>
          <TabsTrigger value="chaos">Chaos</TabsTrigger>
          <TabsTrigger value="timeline">Timeline</TabsTrigger>
          <TabsTrigger value="pnl">Paper PnL</TabsTrigger>
        </TabsList>
        <TabsContent value="inject"><InjectTab /></TabsContent>
        <TabsContent value="scenarios"><ScenariosTab /></TabsContent>
        <TabsContent value="chaos"><ChaosTab /></TabsContent>
        <TabsContent value="timeline"><TimelineTab /></TabsContent>
        <TabsContent value="pnl"><PnlTab /></TabsContent>
      </Tabs>
    </>
  );
}

// ---------------------------------------------------------------------------
// Inject tab
// ---------------------------------------------------------------------------
function InjectTab() {
  const [form, setForm] = useState({
    action: "ENTER-LONG" as (typeof ACTIONS)[number],
    symbol: "BTCUSDT", strategy: "sim", tag: "", strategy_code: "",
    transport: "webhook", price: "100", bar_time: "",
    winrate: "", net_profit: "", profit_factor: "",
    duplicate: false, bypass_dedupe: false,
  });
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  const inject = useMutation({
    mutationFn: async () => {
      const body: Record<string, unknown> = {
        action: form.action, symbol: form.symbol.trim().toUpperCase(),
        strategy: form.strategy, tag: form.tag, transport: form.transport,
        duplicate: form.duplicate, bypass_dedupe: form.bypass_dedupe,
      };
      if (form.strategy_code) body.strategy_code = form.strategy_code;
      if (form.bar_time) body.bar_time = form.bar_time;
      if (form.price && form.action !== "HEALTH") body.price = Number(form.price);
      if (form.action === "HEALTH") {
        if (form.winrate) body.winrate = Number(form.winrate);
        if (form.net_profit) body.net_profit = Number(form.net_profit);
        if (form.profit_factor) body.profit_factor = Number(form.profit_factor);
      }
      const { data, error } = await supabase.functions.invoke("sim-inject", { body });
      if (error) throw error;
      return data;
    },
    onSuccess: (d) => toast.success(`Signal injected: ${(d as { signal_id?: string })?.signal_id ?? "n/a"}`),
    onError: (e) => toast.error((e as Error).message),
  });

  return (
    <Card title="Inject synthetic alert">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        <Field label="Action">
          <Select value={form.action} onValueChange={(v) => set("action", v as typeof form.action)}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {ACTIONS.map((a) => <SelectItem key={a} value={a}>{a}</SelectItem>)}
            </SelectContent>
          </Select>
        </Field>
        <Field label="Symbol"><Input value={form.symbol} onChange={(e) => set("symbol", e.target.value)} /></Field>
        <Field label="Transport">
          <Select value={form.transport} onValueChange={(v) => set("transport", v)}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="webhook">webhook</SelectItem>
              <SelectItem value="email">email</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Field label="Strategy"><Input value={form.strategy} onChange={(e) => set("strategy", e.target.value)} /></Field>
        <Field label="Tag"><Input value={form.tag} onChange={(e) => set("tag", e.target.value)} /></Field>
        <Field label="Strategy code (override)"><Input value={form.strategy_code} placeholder="EL1, XL1, …" onChange={(e) => set("strategy_code", e.target.value)} /></Field>
        <Field label="Bar time (ISO, optional)"><Input value={form.bar_time} onChange={(e) => set("bar_time", e.target.value)} /></Field>
        {form.action !== "HEALTH" && (
          <Field label="Price (paper tick)"><Input type="number" value={form.price} onChange={(e) => set("price", e.target.value)} /></Field>
        )}
        {form.action === "HEALTH" && (
          <>
            <Field label="Winrate"><Input type="number" value={form.winrate} onChange={(e) => set("winrate", e.target.value)} /></Field>
            <Field label="Net profit"><Input type="number" value={form.net_profit} onChange={(e) => set("net_profit", e.target.value)} /></Field>
            <Field label="Profit factor"><Input type="number" value={form.profit_factor} onChange={(e) => set("profit_factor", e.target.value)} /></Field>
          </>
        )}
      </div>
      <div className="mt-4 flex items-center gap-6">
        <label className="flex items-center gap-2 text-sm">
          <Switch checked={form.duplicate} onCheckedChange={(v) => set("duplicate", v)} />
          Send duplicate (test dedupe)
        </label>
        <label className="flex items-center gap-2 text-sm">
          <Switch checked={form.bypass_dedupe} onCheckedChange={(v) => set("bypass_dedupe", v)} />
          Bypass dedupe
        </label>
        <Button className="ml-auto" onClick={() => inject.mutate()} disabled={inject.isPending}>
          {inject.isPending ? "Injecting…" : "Inject alert"}
        </Button>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Scenarios tab
// ---------------------------------------------------------------------------
function ScenariosTab() {
  const qc = useQueryClient();
  const [preset, setPreset] = useState(PRESETS[0].id);
  const [symbol, setSymbol] = useState("BTCUSDT");
  const [basePrice, setBasePrice] = useState("100");

  const runs = useQuery({
    queryKey: ["scenario_runs"],
    queryFn: async () => {
      const { data } = await supabase.from("scenario_runs")
        .select("*").order("started_at", { ascending: false }).limit(20);
      return data ?? [];
    },
    refetchInterval: 2_000,
  });

  const run = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.functions.invoke("sim-scenario", {
        body: { preset, symbol: symbol.toUpperCase(), base_price: Number(basePrice) },
      });
      if (error) throw error;
      return data;
    },
    onSuccess: () => { toast.success("Scenario started"); qc.invalidateQueries({ queryKey: ["scenario_runs"] }); },
    onError: (e) => toast.error((e as Error).message),
  });

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title="Run a scenario">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Preset">
            <Select value={preset} onValueChange={setPreset}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {PRESETS.map((p) => <SelectItem key={p.id} value={p.id}>{p.label}</SelectItem>)}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Symbol"><Input value={symbol} onChange={(e) => setSymbol(e.target.value)} /></Field>
          <Field label="Base price"><Input type="number" value={basePrice} onChange={(e) => setBasePrice(e.target.value)} /></Field>
        </div>
        <Button className="mt-4" onClick={() => run.mutate()} disabled={run.isPending}>
          {run.isPending ? "Starting…" : "Start scenario"}
        </Button>
      </Card>
      <Card title="Recent runs">
        {(runs.data?.length ?? 0) === 0 ? <EmptyState title="No runs yet" /> : (
          <ul className="divide-y divide-border">
            {runs.data!.map((r) => (
              <li key={r.id} className="py-2 text-sm">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium">{r.preset}</span>
                  <span className={`text-xs ${r.status === "completed" ? "text-success" : r.status === "failed" ? "text-danger" : "text-muted-foreground"}`}>{r.status}</span>
                </div>
                <div className="text-xs text-muted-foreground">{r.symbol} · {(r.steps as unknown[]).length} steps · {new Date(r.started_at).toLocaleTimeString()}</div>
                <details className="mt-1">
                  <summary className="cursor-pointer text-xs text-muted-foreground">Step log</summary>
                  <pre className="mt-1 max-h-48 overflow-auto rounded bg-muted/40 p-2 text-[10px] leading-tight">{JSON.stringify(r.steps, null, 2)}</pre>
                </details>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Chaos tab
// ---------------------------------------------------------------------------
function ChaosTab() {
  const qc = useQueryClient();
  const settings = useQuery({
    queryKey: ["app_settings_chaos"],
    queryFn: async () => {
      const { data } = await supabase.from("app_settings").select("id,chaos_config").maybeSingle();
      return data;
    },
  });
  const [cfg, setCfg] = useState<Record<string, number>>({});
  useMemo(() => {
    if (settings.data?.chaos_config) setCfg(settings.data.chaos_config as Record<string, number>);
  }, [settings.data?.chaos_config]);

  const save = useMutation({
    mutationFn: async () => {
      if (!settings.data?.id) throw new Error("settings_missing");
      const { error } = await supabase.from("app_settings")
        .update({ chaos_config: cfg }).eq("id", settings.data.id);
      if (error) throw error;
    },
    onSuccess: () => { toast.success("Chaos config saved"); qc.invalidateQueries({ queryKey: ["app_settings_chaos"] }); },
    onError: (e) => toast.error((e as Error).message),
  });

  const num = (k: string) => Number(cfg[k] ?? 0);
  const setNum = (k: string, v: string) => setCfg((c) => ({ ...c, [k]: Number(v) }));

  return (
    <Card title="Paper-mode chaos toggles">
      <p className="mb-3 text-xs text-muted-foreground">
        These settings only affect paper-mode order simulation. Live mode ignores them.
      </p>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <Field label="Random timeout %"><Input type="number" min={0} max={100} value={num("random_timeout_pct")} onChange={(e) => setNum("random_timeout_pct", e.target.value)} /></Field>
        <Field label="Fill delay (ms)"><Input type="number" min={0} value={num("fill_delay_ms")} onChange={(e) => setNum("fill_delay_ms", e.target.value)} /></Field>
        <Field label="Partial fill % (0 = off)"><Input type="number" min={0} max={100} value={num("partial_fill_pct")} onChange={(e) => setNum("partial_fill_pct", e.target.value)} /></Field>
        <Field label="Duplicate delivery %"><Input type="number" min={0} max={100} value={num("duplicate_delivery_pct")} onChange={(e) => setNum("duplicate_delivery_pct", e.target.value)} /></Field>
        <Field label="Stale lock (ms)"><Input type="number" min={0} value={num("stale_lock_ms")} onChange={(e) => setNum("stale_lock_ms", e.target.value)} /></Field>
      </div>
      <Button className="mt-4" onClick={() => save.mutate()} disabled={save.isPending}>Save chaos config</Button>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Timeline tab — visualizes position_events for the most recent positions
// ---------------------------------------------------------------------------
function TimelineTab() {
  const positions = useQuery({
    queryKey: ["positions_recent"],
    queryFn: async () => {
      const { data } = await supabase.from("positions")
        .select("id,symbol,side,execution_mode,opened_at,closed_at,protection_state")
        .order("opened_at", { ascending: false }).limit(15);
      return data ?? [];
    },
    refetchInterval: 3_000,
  });
  const [posId, setPosId] = useState<string | null>(null);
  const events = useQuery({
    queryKey: ["position_events", posId],
    enabled: !!posId,
    queryFn: async () => {
      const { data } = await supabase.from("position_events")
        .select("*").eq("position_id", posId!)
        .order("created_at", { ascending: true });
      return data ?? [];
    },
    refetchInterval: 2_000,
  });

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <Card title="Positions">
        {(positions.data?.length ?? 0) === 0 ? <EmptyState title="No positions" /> : (
          <ul className="divide-y divide-border">
            {positions.data!.map((p) => (
              <li key={p.id}>
                <button
                  onClick={() => setPosId(p.id)}
                  className={`w-full px-2 py-2 text-left text-sm hover:bg-accent/40 ${posId === p.id ? "bg-accent/60" : ""}`}
                >
                  <div className="font-medium">{p.symbol} <span className="text-xs text-muted-foreground">{p.side} · {p.execution_mode}</span></div>
                  <div className="text-xs text-muted-foreground">{p.protection_state} · {new Date(p.opened_at).toLocaleTimeString()}</div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <div className="lg:col-span-2">
        <Card title="State timeline">
          {!posId ? <EmptyState title="Select a position" /> :
            (events.data?.length ?? 0) === 0 ? <EmptyState title="No events yet" /> : (
              <ol className="relative space-y-3 border-l border-border pl-4">
                {events.data!.map((e) => (
                  <li key={e.id} className="relative">
                    <span className="absolute -left-[21px] top-1 h-3 w-3 rounded-full border border-border bg-background" />
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-medium">{e.event_type}</span>
                      <span className="text-xs text-muted-foreground tabular">{new Date(e.created_at).toLocaleTimeString()}</span>
                    </div>
                    {e.detail != null && (
                      <pre className="mt-1 overflow-auto rounded bg-muted/40 p-2 text-[10px] leading-tight">{JSON.stringify(e.detail, null, 2)}</pre>
                    )}
                  </li>
                ))}
              </ol>
            )}
        </Card>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// PnL tab — cumulative realized PnL from paper exit events
// ---------------------------------------------------------------------------
function PnlTab() {
  const events = useQuery({
    queryKey: ["paper_pnl_events"],
    queryFn: async () => {
      // Get exit events on paper positions; reconstruct cumulative PnL.
      const { data: positions } = await supabase
        .from("positions").select("id,entry_price,side").eq("execution_mode", "paper");
      const map = new Map<string, { entry: number; side: string }>();
      for (const p of positions ?? []) {
        if (p.entry_price != null)
          map.set(p.id, { entry: Number(p.entry_price), side: p.side });
      }
      const { data: ev } = await supabase.from("position_events")
        .select("position_id,event_type,detail,created_at")
        .in("event_type", ["exit_tp1", "exit_tp2_rest", "exit_exit_full", "sl_triggered", "tsl_triggered"])
        .order("created_at", { ascending: true })
        .limit(500);

      let cum = 0;
      return (ev ?? []).map((e) => {
        const p = map.get(e.position_id);
        const d = e.detail as { fill_price?: number; qty?: number } | null;
        if (p && d?.fill_price != null && d?.qty != null) {
          const dir = p.side === "long" ? 1 : -1;
          cum += (Number(d.fill_price) - p.entry) * Number(d.qty) * dir;
        }
        return { t: new Date(e.created_at).toLocaleTimeString(), pnl: Number(cum.toFixed(2)) };
      });
    },
    refetchInterval: 3_000,
  });

  const wallet = useQuery({
    queryKey: ["paper_wallet_simulator"],
    queryFn: async () => {
      const { data } = await supabase.from("paper_wallet").select("*").maybeSingle();
      return data;
    },
    refetchInterval: 3_000,
  });

  return (
    <div className="grid gap-4">
      <Card title="Paper wallet">
        <div className="grid grid-cols-3 gap-4 text-sm">
          <Stat label="Balance" value={`${Number(wallet.data?.balance_usdt ?? 0).toFixed(2)} USDT`} />
          <Stat label="Realized PnL" value={`${Number(wallet.data?.realized_pnl ?? 0).toFixed(2)} USDT`} />
          <Stat label="Equity" value={`${Number(wallet.data?.equity_usdt ?? 0).toFixed(2)} USDT`} />
        </div>
      </Card>
      <Card title="Cumulative realized PnL">
        {(events.data?.length ?? 0) === 0 ? <EmptyState title="No paper exits yet" /> : (
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={events.data!}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                <XAxis dataKey="t" tick={{ fontSize: 10 }} />
                <YAxis tick={{ fontSize: 10 }} />
                <Tooltip contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))" }} />
                <Line type="monotone" dataKey="pnl" stroke="hsl(var(--primary))" dot={false} strokeWidth={2} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      {children}
    </div>
  );
}
function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="mt-1 text-base font-semibold tabular">{value}</div>
    </div>
  );
}
