import { useState } from "react";
import { Link, createFileRoute } from "@tanstack/react-router";
import { AuthFrame } from "@/components/auth-frame";

export const Route = createFileRoute("/forgot")({ component: Forgot });

function Forgot() {
  const [email, setEmail] = useState("");
  const [error, setError] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const res = await fetch("/api/auth/request-password-reset", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email,
          redirectTo: `${window.location.origin}/reset-password`,
        }),
      });
      const body = (await res.json().catch(() => null)) as { message?: string } | null;
      if (!res.ok) throw new Error(body?.message || "Could not send the reset email.");
      setSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not send the reset email.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthFrame title="Reset your password" lede="Enter the work email on your account. If it exists, we send a reset link.">
      {sent ? (
        <p className="text-sm text-fg">If that email is registered, the reset link is on its way. The link expires in one hour.</p>
      ) : (
        <form className="space-y-3" onSubmit={onSubmit}>
          <input className="field" type="email" required placeholder="Work email" value={email} onChange={(e) => setEmail(e.target.value)} />
          {error ? <p className="text-sm text-danger">{error}</p> : null}
          <button className="btn w-full" type="submit" disabled={busy}>
            {busy ? "Please wait…" : "Send reset link"}
          </button>
        </form>
      )}
      <Link to="/login" search={{ mode: "in" }} className="text-sm text-accent">
        Back to sign in
      </Link>
    </AuthFrame>
  );
}
