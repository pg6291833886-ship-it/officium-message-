import { Link, createFileRoute } from "@tanstack/react-router";
import { Workspace } from "@/components/workspace";
import { Brand } from "@/components/auth-frame";
import { useCurrentUserState } from "@/lib/auth/use-current-user";

export const Route = createFileRoute("/")({ component: Home });

function Home() {
  const { user, isPending } = useCurrentUserState();
  if (isPending) {
    return (
      <main className="grid min-h-dvh place-items-center bg-ink text-paper">
        <p className="font-serif text-2xl">Officium Message</p>
      </main>
    );
  }
  if (!user) return <Landing />;
  return <Workspace />;
}

function Landing() {
  return (
    <main className="min-h-dvh bg-ink text-paper">
      <header className="flex items-center justify-between px-5 py-5 sm:px-10">
        <Brand light />
        <Link to="/login" search={{ mode: "in" }} className="btn on-dark">
          Sign in
        </Link>
      </header>
      <section className="mx-auto grid max-w-5xl gap-10 px-5 py-16 sm:px-10 lg:grid-cols-[1.2fr_0.8fr] lg:items-end">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-accent-2">Officium Connect</p>
          <h1 className="mt-3 max-w-xl font-serif text-5xl leading-[1.05] sm:text-6xl">Private team messaging for recruiting.</h1>
          <p className="mt-5 max-w-lg text-base leading-7 text-side-muted">
            Talk with your team, follow candidates, and keep files in one workspace. This is not a public chat.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link to="/login" search={{ mode: "in" }} className="btn">
              Sign in
            </Link>
            <Link to="/login" search={{ mode: "up" }} className="btn on-dark">
              Create account
            </Link>
          </div>
        </div>
        <ul className="space-y-3 text-sm">
          <li className="rounded-xl border border-white/10 bg-white/5 px-4 py-3">Channels for announcements and daily work</li>
          <li className="rounded-xl border border-white/10 bg-white/5 px-4 py-3">Direct messages that stay inside the team</li>
          <li className="rounded-xl border border-white/10 bg-white/5 px-4 py-3">Private file storage, not public links</li>
        </ul>
      </section>
    </main>
  );
}
