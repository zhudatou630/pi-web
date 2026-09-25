import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./ChatInput.tsx", import.meta.url), "utf8");
const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

test("anchors the mobile reasoning menu with a clamped width", () => {
  assert.match(source, /thinkingDropdownOpen && \([\s\S]*?className="chat-input-menu menu-surface" style=\{\{ left: 0/);
  assert.match(css, /\.menu-surface \{[^}]*max-width: calc\(100vw - 24px\);[\s\S]*\.chat-input-menu \{[^}]*bottom: calc\(100% \+ 6px\);/);
});
