import { useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { GROK_PROVIDERS, authClient, authEnabled, signIn } from "@/lib/auth/client";
import { useCurrentUserState } from "@/lib/auth/use-current-user";

export const Route = createFileRoute("/login")({ component: Login });

const BEARER_KEY = "grok-auth.bearer-token";

function Login() {
  const { user, isPending } = useCurrentUserState();
  const navigate = useNavigate();
  const [mode, setMode] = useState<"in" | "up">("in");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  if (!isPending && user) {
    void navigate({ to: "/" });
  }

  async function finish(token?: string | null) {
    if (token) {
      try {
        sessionStorage.setItem(BEARER_KEY, token);
      } catch {
        /* ignore */
      }
    }
    window.location.href = "/";
  }

  async function onEmail(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      if (mode === "up") {
        const created = await authClient.signUp.email({
          email,
          password,
          name: name.trim() || email.split("@")[0] || "Member",
        });
        if (created.error) throw new Error(created.error.message ?? "Could not create the account.");
        await finish((created.data as { token?: string } | null)?.token);
        return;
      }
      const signed = await authClient.signIn.email({ email, password });
      if (signed.error) throw new Error(signed.error.message ?? "Could not sign in.");
      await finish((signed.data as { token?: string } | null)?.token);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign-in failed.");
      setBusy(false);
    }
  }

  return (
    <main className="grid min-h-dvh place-items-center bg-paper px-4 py-8">
      <div className="w-full max-w-sm">
        <div className="mb-4 flex items-center gap-3">
          <img src="/officium-mark.png" alt="Officium Connect" className="h-12 w-12 rounded-xl object-cover" />
          <div>
            <p className="text-lg font-semibold text-ink">Officium Message</p>
            <p className="text-xs text-muted">Officium Connect</p>
          </div>
        </div>
        <p className="text-sm text-muted">
          Team messaging for Officium Connect. Sign in to your own account. Messages stay in the workspace database.
        </p>
        <div className="card mt-6 space-y-3">
          {isPending ? <p className="text-sm text-muted">Checking your session…</p> : null}
          {authEnabled ? (
            <>
              {GROK_PROVIDERS.map((p) => (
                <button
                  key={p.providerId}
                  type="button"
                  className="btn ghost w-full"
                  onClick={() => {
                    void signIn(p.providerId, { callbackURL: "/" }).catch((err: unknown) => {
                      setError(err instanceof Error ? err.message : "Sign-in failed.");
                    });
                  }}
                >
                  Continue with {p.label}
                </button>
              ))}
              <div className="h-px bg-line" />
              <form className="space-y-3" onSubmit={onEmail}>
                {mode === "up" ? (
                  <input className="field" placeholder="Your name" value={name} onChange={(e) => setName(e.target.value)} />
                ) : null}
                <input className="field" type="email" required placeholder="Work email" value={email} onChange={(e) => setEmail(e.target.value)} />
                <input className="field" type="password" required minLength={8} placeholder="Password (8+ characters)" value={password} onChange={(e) => setPassword(e.target.value)} />
                {error ? <p className="text-sm text-danger">{error}</p> : null}
                <button className="btn w-full" type="submit" disabled={busy}>
                  {busy ? "Please wait…" : mode === "up" ? "Create account" : "Sign in with email"}
                </button>
              </form>
              <button type="button" className="text-sm text-accent" onClick={() => setMode(mode === "in" ? "up" : "in")}>
                {mode === "in" ? "Need an account? Register" : "Already registered? Sign in"}
              </button>
            </>
          ) : (
            <p className="text-sm text-muted">Sign-in is disabled.</p>
          )}
        </div>
      </div>
    </main>
  );
}
