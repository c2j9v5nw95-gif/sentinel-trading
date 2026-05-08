import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { PageHeader, Card, EmptyState } from "@/components/PageHeader";

export const Route = createFileRoute("/_app/signals")({
  component: SignalsPage,
});

function SignalsPage() {
  const { data } = useQuery({
    queryKey: ["signals"],
    queryFn: async () => {
      const { data } = await supabase
        .from("signals")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(200);
      return data ?? [];
    },
    refetchInterval: 5_000,
  });

  return (
    <>
      <PageHeader title="Signals" description="Normalized + deduped signal stream." />
      <Card>
        {(data?.length ?? 0) === 0 ? (
          <EmptyState title="No signals yet" />
        ) : (
          <table className="w-full text-sm tabular">
            <thead className="text-left text-xs uppercase text-muted-foreground">
              <tr>
                <th className="py-2">Time</th>
                <th>Transport</th>
                <th>Symbol</th>
                <th>Action</th>
                <th>Strategy</th>
                <th>Tag</th>
                <th>Portion</th>
                <th>Status</th>
                <th>Decision</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {data!.map((s) => (
                <tr key={s.id}>
                  <td className="py-2 text-xs text-muted-foreground">
                    {new Date(s.created_at).toLocaleTimeString()}
                  </td>
                  <td className="text-xs">{s.transport}</td>
                  <td className="font-medium">{s.symbol ?? "—"}</td>
                  <td>{s.action ?? "—"}</td>
                  <td>{s.strategy ?? "—"}</td>
                  <td className="text-xs text-muted-foreground">{s.tag}</td>
                  <td className="text-xs">{s.portion}</td>
                  <td
                    className={
                      s.status === "rejected" || s.status === "error"
                        ? "text-danger text-xs uppercase"
                        : s.status === "accepted"
                        ? "text-success text-xs uppercase"
                        : s.status === "processed"
                        ? "text-xs uppercase text-muted-foreground"
                        : "text-xs uppercase text-muted-foreground"
                    }
                  >
                    {s.status}
                  </td>
                  <td className="text-xs text-muted-foreground max-w-[280px] truncate" title={s.decision_reason ?? ""}>
                    {s.decision_reason ?? "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </>
  );
}
