import { createFileRoute } from "@tanstack/react-router";
import { clientIpForRateLimit } from "@/lib/auth/client-ip";
import { auth } from "@/lib/auth/server";

// Better Auth rate-limits by a single x-forwarded-for address. With none, a
// hostname, or several hops and no trusted-proxy list, production logs
// "could not determine a client IP" and puts every caller in one bucket.
// Local preview appends the socket address onto the header. The hosted
// platform sets a real client address; that single address is preserved.
// Rebuilding via `new Request(request)` crashes here: TanStack's request is a
// different undici realm, so the constructor reads `.window` off undefined.
function withClientIp(request: Request) {
  const resolved = clientIpForRateLimit(
    request.headers.get("x-forwarded-for"),
    request.headers.get("x-real-ip"),
  );
  if (request.headers.get("x-forwarded-for") === resolved) return request;
  try {
    request.headers.set("x-forwarded-for", resolved);
    if (request.headers.get("x-forwarded-for") === resolved) return request;
  } catch {
    // Immutable headers — build a new request from the URL string below.
  }
  const headers = new Headers();
  request.headers.forEach((value, key) => {
    if (key.toLowerCase() !== "x-forwarded-for") headers.append(key, value);
  });
  headers.set("x-forwarded-for", resolved);
  const init: RequestInit & { duplex?: "half" } = {
    method: request.method,
    headers,
  };
  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = request.body;
    init.duplex = "half";
  }
  return new Request(request.url, init);
}

export const Route = createFileRoute("/api/auth/$")({
  server: {
    handlers: {
      GET: ({ request }) => auth.handler(withClientIp(request)),
      POST: ({ request }) => auth.handler(withClientIp(request)),
    },
  },
});
