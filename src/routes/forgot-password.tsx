import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";

export const Route = createFileRoute("/forgot-password")({
  component: ForgotPasswordPage,
});

function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/reset-password`,
    });
    setBusy(false);
    if (error) {
      setErr(error.message);
      return;
    }
    setSent(true);
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <form
        onSubmit={submit}
        className="w-full max-w-sm rounded-lg border border-border bg-card p-6 shadow-sm"
      >
        <h1 className="text-lg font-semibold tracking-tight">Glemt passord</h1>
        <p className="mt-1 text-xs text-muted-foreground">
          Skriv inn e-posten du logger inn med. Vi sender en reset-lenke.
        </p>

        {sent ? (
          <p className="mt-4 rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-400">
            Hvis kontoen finnes, er en reset-lenke sendt til {email}. Sjekk innboksen
            (og spam).
          </p>
        ) : (
          <>
            <label className="mt-5 block text-xs font-medium text-muted-foreground">
              Email
            </label>
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
            />

            {err && (
              <p className="mt-3 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
                {err}
              </p>
            )}

            <button
              type="submit"
              disabled={busy}
              className="mt-5 w-full rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground transition hover:bg-primary/90 disabled:opacity-60"
            >
              {busy ? "..." : "Send reset-lenke"}
            </button>
          </>
        )}

        <Link
          to="/login"
          className="mt-3 block text-center text-xs text-muted-foreground hover:text-foreground"
        >
          Tilbake til login
        </Link>
      </form>
    </div>
  );
}
