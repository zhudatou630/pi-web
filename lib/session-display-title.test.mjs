import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const {
  getSessionDisplayTitle,
  getSessionFirstMessagePreview,
  SESSION_FIRST_MESSAGE_PREVIEW_MAX_LENGTH,
} = await createJiti(import.meta.url).import("./session-display-title.ts");

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

test("session-list first messages are bounded after skill expansion collapse", () => {
  assert.equal(
    getSessionFirstMessagePreview("x".repeat(SESSION_FIRST_MESSAGE_PREVIEW_MAX_LENGTH + 100)),
    "x".repeat(SESSION_FIRST_MESSAGE_PREVIEW_MAX_LENGTH),
  );

  const firstMessage = `<skill name="review" location="/tmp/SKILL.md">
References are relative to /tmp.

${"large body\n".repeat(1000)}</skill>

src/main.ts`;
  assert.equal(getSessionFirstMessagePreview(firstMessage), "/skill:review src/main.ts");
});

test("preview limits do not split Unicode surrogate pairs", () => {
  const emoji = "\u{1F600}";
  const preview = getSessionFirstMessagePreview(
    `${"x".repeat(SESSION_FIRST_MESSAGE_PREVIEW_MAX_LENGTH - 1)}${emoji}tail`,
  );
  assert.equal(preview, "x".repeat(SESSION_FIRST_MESSAGE_PREVIEW_MAX_LENGTH - 1));
  assert.equal(preview.isWellFormed(), true);

  const title = getSessionDisplayTitle({ id: "abcdefghijkl", firstMessage: `${"x".repeat(49)}${emoji}tail` });
  assert.equal(title, "x".repeat(49));
  assert.equal(title.isWellFormed(), true);
});
