import assert from "node:assert/strict";
import test from "node:test";
import { getIPFromHeader } from "@better-auth/core/utils/ip";
import { canonicalClientIp, clientIpForRateLimit } from "./client-ip.ts";

function accepted(header: string | null, realIp?: string | null) {
  const chosen = clientIpForRateLimit(header, realIp);
  return { chosen, resolved: getIPFromHeader(chosen) };
}

test("canonical client addresses match what Better Auth accepts", () => {
  assert.equal(canonicalClientIp("203.0.113.9"), "203.0.113.9");
  assert.equal(canonicalClientIp("::ffff:127.0.0.1"), "127.0.0.1");
  assert.equal(canonicalClientIp("127.0.0.1:8081"), "127.0.0.1");
  assert.equal(canonicalClientIp("[::1]"), "::1");
  assert.equal(canonicalClientIp("localhost"), null);
  assert.equal(canonicalClientIp("unknown"), null);
  assert.equal(canonicalClientIp("999.999.999.999"), null);
});

test("rate-limit header is a single address Better Auth can resolve", () => {
  const cases: Array<[string | null, string | null | undefined, string]> = [
    [null, null, "127.0.0.1"],
    ["", null, "127.0.0.1"],
    ["localhost", null, "127.0.0.1"],
    ["127.0.0.1, ::ffff:127.0.0.1", null, "127.0.0.1"],
    ["203.0.113.5", null, "203.0.113.5"],
    ["203.0.113.5, 198.51.100.8", "198.51.100.8", "198.51.100.8"],
    ["203.0.113.5, 198.51.100.8", null, "203.0.113.5"],
    ["not-an-ip, 198.51.100.20", null, "198.51.100.20"],
  ];
  for (const [header, real, expected] of cases) {
    const result = accepted(header, real);
    assert.equal(result.chosen, expected, `chosen for ${header}`);
    assert.equal(result.resolved, expected, `resolved for ${header}`);
  }
});
