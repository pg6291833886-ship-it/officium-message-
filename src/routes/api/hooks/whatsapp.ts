import { createFileRoute } from "@tanstack/react-router";
import { getSql } from "@/lib/db";
import { ingestWhatsapp, verifyMetaSignature, verifySharedSecret } from "@/lib/message/platform";

export const Route = createFileRoute("/api/hooks/whatsapp")({
  server: {
    handlers: {
      GET: ({ request }) => {
        const url = new URL(request.url);
        const mode = url.searchParams.get("hub.mode");
        const token = url.searchParams.get("hub.verify_token");
        const challenge = url.searchParams.get("hub.challenge");
        const expected = process.env.WHATSAPP_VERIFY_TOKEN?.trim() ?? "";
        if (!expected) return new Response("WhatsApp verify token is not configured.", { status: 503 });
        if (mode === "subscribe" && challenge && verifySharedSecret(expected, token)) {
          return new Response(challenge, { status: 200, headers: { "content-type": "text/plain" } });
        }
        return new Response("Verification failed.", { status: 403 });
      },
      POST: async ({ request }) => {
        const secret = process.env.WHATSAPP_APP_SECRET?.trim() ?? "";
        if (!secret) return new Response("WhatsApp app secret is not configured.", { status: 503 });
        const raw = await request.text();
        if (!await verifyMetaSignature(secret, raw, request.headers.get("x-hub-signature-256"))) {
          return new Response("Invalid signature.", { status: 401 });
        }
        let payload: unknown;
        try {
          payload = JSON.parse(raw);
        } catch {
          return new Response("Invalid JSON.", { status: 400 });
        }
        const sql = await getSql();
        const result = await ingestWhatsapp(sql, payload);
        return Response.json({ ok: true, ...result });
      },
    },
  },
});
