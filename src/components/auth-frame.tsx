import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";

export function Brand({ light = false }: { light?: boolean }) {
  return (
    <Link to="/" className="flex items-center gap-3">
      <img src="/officium-mark.png" alt="" className="h-11 w-11 rounded-xl object-cover" />
      <span>
        <span className={`block text-base font-semibold ${light ? "text-paper" : "text-ink"}`}>Officium Message</span>
        <span className={`block text-xs ${light ? "text-side-muted" : "text-muted"}`}>Officium Connect</span>
      </span>
    </Link>
  );
}

export function AuthFrame({ title, lede, children }: { title: string; lede: string; children: ReactNode }) {
  return (
    <main className="grid min-h-dvh lg:grid-cols-[1.1fr_0.9fr]">
      <section className="flex flex-col justify-between bg-ink px-6 py-8 text-paper sm:px-10 lg:px-14">
        <Brand light />
        <div className="max-w-lg py-12">
          <p className="font-serif text-4xl leading-tight sm:text-5xl">The workspace for Officium Connect.</p>
          <p className="mt-4 max-w-md text-sm leading-6 text-side-muted">
            Channels, direct messages, and private files for the recruitment team. Sign in with your work email.
          </p>
        </div>
        <p className="text-xs text-side-muted">message.officiumconnect.in</p>
      </section>
      <section className="grid place-items-center bg-paper px-4 py-10">
        <div className="w-full max-w-sm">
          <h1 className="text-2xl font-semibold text-ink">{title}</h1>
          <p className="mt-2 text-sm leading-6 text-muted">{lede}</p>
          <div className="card mt-6 space-y-3">{children}</div>
        </div>
      </section>
    </main>
  );
}
