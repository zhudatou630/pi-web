import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { getSessionDisplayTitle } = await createJiti(import.meta.url).import("./session-display-title.ts");

test("named sessions keep their stored title", () => {
  assert.equal(getSessionDisplayTitle({ id: "abcdefghijkl", name: "Named", firstMessage: "ignored" }), "Named");
});

test("unnamed sessions reuse the sidebar first-message fallback", () => {
  const firstMessage = "A reasonably long first user message that should be truncated at fifty chars!!";
  assert.equal(getSessionDisplayTitle({
    id: "abcdefghijkl",
    firstMessage,
  }), firstMessage.slice(0, 50));
  assert.equal(getSessionDisplayTitle({ id: "abcdefghijklmnop" }), "abcdefghijkl");
});

test("skill expansions collapse to the compact command before truncating", () => {
  const firstMessage = `<skill name="review" location="/tmp/SKILL.md">
References are relative to /tmp.

Review the diff.
</skill>`;
  assert.equal(getSessionDisplayTitle({ id: "abcdefghijkl", firstMessage }), "/skill:review");
});
