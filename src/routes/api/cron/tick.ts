import { createFileRoute } from "@tanstack/react-router";
import { getSql } from "@/lib/db";
import { runMaintenance } from "@/lib/message/api";
import { verifySharedSecret } from "@/lib/message/platform";

async function tick(request: Request) {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) {
    return Response.json(
      { ok: false, error: "CRON_SECRET is not set. The scheduler did not run." },
      { status: 503 },
    );
  }
  const header = request.headers.get("authorization") ?? "";
  const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
  if (!verifySharedSecret(secret, token)) return new Response("Unauthorized", { status: 401 });
  const sql = await getSql();
  const result = await runMaintenance(sql);
  return Response.json({ ok: true, reminders: result.reminders.length, jobs: result.jobs, schedules: result.schedules });
}

export const Route = createFileRoute("/api/cron/tick")({
  server: {
    handlers: {
      GET: ({ request }) => tick(request),
      POST: ({ request }) => tick(request),
    },
  },
});
