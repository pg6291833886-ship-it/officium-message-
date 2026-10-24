import { z } from "zod";

/**
 * One address Better Auth will accept as the only value of `x-forwarded-for`.
 * Returns null for hostnames, ports, and anything Zod rejects.
 */
export function canonicalClientIp(token: string): string | null {
  let ip = token.trim().replace(/^"|"$/g, "");
  if (!ip || ip.toLowerCase() === "unknown") return null;
  if (ip.startsWith("[")) {
    const end = ip.indexOf("]");
    if (end > 1) ip = ip.slice(1, end);
  } else {
    const withPort = /^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/.exec(ip);
    if (withPort?.[1]) ip = withPort[1];
  }
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (mapped?.[1]) ip = mapped[1];
  if (z.ipv4().safeParse(ip).success || z.ipv6().safeParse(ip).success) return ip;
  return null;
}

/**
 * Address to put in `x-forwarded-for` before Better Auth rate-limits.
 *
 * Better Auth trusts that header only when it holds a single valid IP, and in
 * production it does not fall back to loopback. Local preview appends the
 * socket address, so `127.0.0.1, ::ffff:127.0.0.1` used to collapse every
 * caller into one unnamed bucket and log a warning. A single platform address
 * is kept. Distinct addresses prefer `x-real-ip` when that is valid, otherwise
 * the leftmost forwarded client. Missing or unusable input becomes loopback so
 * preview does not share the unnamed bucket.
 */
export function clientIpForRateLimit(
  forwardedFor: string | null,
  realIp?: string | null,
): string {
  const forwarded = (forwardedFor ?? "")
    .split(",")
    .map((part) => canonicalClientIp(part))
    .filter((ip): ip is string => ip !== null);
  const distinct = [...new Set(forwarded)];
  if (distinct.length === 1) return distinct[0]!;
  const real = realIp ? canonicalClientIp(realIp) : null;
  if (distinct.length > 1) return real ?? distinct[0]!;
  return real ?? "127.0.0.1";
}
