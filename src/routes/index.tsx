import { createFileRoute } from "@tanstack/react-router";
import { RedirectToSignIn } from "@/lib/auth/gates";
import { useCurrentUserState } from "@/lib/auth/use-current-user";
import { Workspace } from "@/components/workspace";

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
  if (!user) return <RedirectToSignIn />;
  return <Workspace />;
}
