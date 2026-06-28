import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

export const Route = createFileRoute("/reset-password")({
  component: ResetPasswordPage,
});

function ResetPasswordPage() {
  const nav = useNavigate();
  const [ready, setReady] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  // Supabase legger recovery-tokenet i URL-hash (#access_token=...&type=recovery).
  // detectSessionInUrl tar dette automatisk, men vi venter til en session finnes.
  useEffect(() => {
    if (typeof window === "undefined") return;

    const check = async () => {
      const { data } = await supabase.auth.getSession();
      if (data.session) {
        setReady(true);
        return true;
      }
      return false;
    };

    (async () => {
      if (await check()) return;
      // Vent på at Supabase prosesserer hash-fragmentet
      const { data: sub } = supabase.auth.onAuthStateChange((event) => {
        if (event === "PASSWORD_RECOVERY" || event === "SIGNED_IN") {
          setReady(true);
        }
      });
      // Fallback: hvis ingen session etter 2s, vis feilmelding
      setTimeout(async () => {
        if (!(await check())) {
          setLinkError(
            "Reset-lenken er ugyldig eller utløpt. Be om en ny fra login-siden.",
          );
        }
      }, 2000);
      return () => sub.subscription.unsubscribe();
    })();
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    if (password.length < 8) {
      setErr("Passordet må være minst 8 tegn.");
      return;
    }
    if (password !== confirm) {
      setErr("Passordene er ikke like.");
      return;
    }
    setBusy(true);
    const { error } = await supabase.auth.updateUser({ password });
    setBusy(false);
    if (error) {
      setErr(error.message);
      return;
    }
    setDone(true);
    setTimeout(() => nav({ to: "/login" }), 1500);
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm rounded-lg border border-border bg-card p-6 shadow-sm">
        <h1 className="text-lg font-semibold tracking-tight">Sett nytt passord</h1>
        <p className="mt-1 text-xs text-muted-foreground">
          Skriv inn et nytt passord for operatør-kontoen din.
        </p>

        {linkError && (
          <p className="mt-4 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
            {linkError}
          </p>
        )}

        {done && (
          <p className="mt-4 rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-400">
            Passordet er oppdatert. Sender deg til login…
          </p>
        )}

        {!linkError && !done && (
          <form onSubmit={submit}>
            <label className="mt-5 block text-xs font-medium text-muted-foreground">
              Nytt passord
            </label>
            <input
              type="password"
              required
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={!ready}
              className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring disabled:opacity-60"
            />

            <label className="mt-3 block text-xs font-medium text-muted-foreground">
              Bekreft passord
            </label>
            <input
              type="password"
              required
              minLength={8}
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              disabled={!ready}
              className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring disabled:opacity-60"
            />

            {err && (
              <p className="mt-3 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
                {err}
              </p>
            )}

            <button
              type="submit"
              disabled={busy || !ready}
              className="mt-5 w-full rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground transition hover:bg-primary/90 disabled:opacity-60"
            >
              {busy ? "..." : ready ? "Lagre nytt passord" : "Validerer lenke…"}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
