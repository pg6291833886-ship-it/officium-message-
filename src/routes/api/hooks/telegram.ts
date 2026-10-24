import { createFileRoute } from "@tanstack/react-router";
import { getSql } from "@/lib/db";
import { ingestTelegram, verifySharedSecret } from "@/lib/message/platform";

export const Route = createFileRoute("/api/hooks/telegram")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const secret = process.env.TELEGRAM_WEBHOOK_SECRET?.trim() ?? "";
        if (!secret) return new Response("Telegram webhook secret is not configured.", { status: 503 });
        if (!verifySharedSecret(secret, request.headers.get("x-telegram-bot-api-secret-token"))) {
          return new Response("Invalid webhook secret.", { status: 401 });
        }
        let payload: unknown;
        try {
          payload = JSON.parse(await request.text());
        } catch {
          return new Response("Invalid JSON.", { status: 400 });
        }
        const sql = await getSql();
        const result = await ingestTelegram(sql, payload);
        return Response.json({ ok: true, ...result });
      },
    },
  },
});
