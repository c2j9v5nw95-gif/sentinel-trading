import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { PageHeader, Card, EmptyState } from "@/components/PageHeader";

export const Route = createFileRoute("/_app/audit")({
  component: AuditPage,
});

function AuditPage() {
  const { data } = useQuery({
    queryKey: ["audit"],
    queryFn: async () => {
      const [audit, errors] = await Promise.all([
        supabase
          .from("audit_log")
          .select("*")
          .order("created_at", { ascending: false })
          .limit(100),
        supabase
          .from("error_log")
          .select("*")
          .order("created_at", { ascending: false })
          .limit(100),
      ]);
      return { audit: audit.data ?? [], errors: errors.data ?? [] };
    },
  });

  return (
    <>
      <PageHeader title="Audit & errors" description="Operator actions and runtime errors." />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card title="Audit log">
          {(data?.audit.length ?? 0) === 0 ? (
            <EmptyState title="No audit entries" />
          ) : (
            <ul className="divide-y divide-border text-sm">
              {data!.audit.map((a) => (
                <li key={a.id} className="py-2">
                  <div className="font-medium">{a.action}</div>
                  <div className="text-xs text-muted-foreground tabular">
                    {a.target ?? ""} · {new Date(a.created_at).toLocaleString()}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="Errors">
          {(data?.errors.length ?? 0) === 0 ? (
            <EmptyState title="No errors" />
          ) : (
            <ul className="divide-y divide-border text-sm">
              {data!.errors.map((e) => (
                <li key={e.id} className="py-2">
                  <div className="font-medium text-danger">{e.source ?? "unknown"}</div>
                  <div className="text-xs text-muted-foreground">{e.message}</div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
