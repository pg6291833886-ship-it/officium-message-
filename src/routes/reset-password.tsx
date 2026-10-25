import { useEffect, useState } from "react";
import { Link, createFileRoute } from "@tanstack/react-router";
import { AuthFrame } from "@/components/auth-frame";

export const Route = createFileRoute("/reset-password")({ component: ResetPassword });

function ResetPassword() {
  const [ready, setReady] = useState(false);
  const [token, setToken] = useState("");
  const [invalid, setInvalid] = useState(false);
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setToken(params.get("token") ?? "");
    setInvalid(params.get("error") === "INVALID_TOKEN");
    setReady(true);
  }, []);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const res = await fetch("/api/auth/reset-password", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ newPassword: password, token }),
      });
      const body = (await res.json().catch(() => null)) as { message?: string } | null;
      if (!res.ok) throw new Error(body?.message || "This reset link is no longer valid.");
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "This reset link is no longer valid.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthFrame title="Choose a new password" lede="Use at least 8 characters. This link works once.">
      {done ? (
        <p className="text-sm text-fg">Your password is updated. Sign in with the new one.</p>
      ) : !ready ? (
        <p className="text-sm text-muted">Checking the link…</p>
      ) : invalid || !token ? (
        <p className="text-sm text-danger">This reset link is missing or has expired. Request a new one.</p>
      ) : (
        <form className="space-y-3" onSubmit={onSubmit}>
          <input className="field" type="password" required minLength={8} placeholder="New password" value={password} onChange={(e) => setPassword(e.target.value)} />
          {error ? <p className="text-sm text-danger">{error}</p> : null}
          <button className="btn w-full" type="submit" disabled={busy}>
            {busy ? "Please wait…" : "Update password"}
          </button>
        </form>
      )}
      <Link to="/login" search={{ mode: "in" }} className="text-sm text-accent">
        Sign in
      </Link>
      <Link to="/forgot" className="text-sm text-accent">
        Request a new link
      </Link>
    </AuthFrame>
  );
}
