import assert from "node:assert/strict";
import test from "node:test";
import { searchEmojis } from "./emoji.ts";

test("emoji search returns the full set when the query is empty", () => {
  const all = searchEmojis("  ");
  assert.ok(all.length >= 40);
  assert.equal(new Set(all.map((e) => e.char)).size, all.length);
});

test("emoji search matches a keyword and rejects an unknown word", () => {
  const hits = searchEmojis("remind");
  assert.ok(hits.some((e) => e.char === "⏰"));
  assert.equal(searchEmojis("not-a-real-emoji-word").length, 0);
});
