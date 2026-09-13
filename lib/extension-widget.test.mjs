import assert from "node:assert/strict";
import test from "node:test";
import { applyWidgetEvent } from "./extension-widget.ts";

test("set replaces the current widget", () => {
  const next = applyWidgetEvent(null, "todos", ["a", "b"]);
  assert.deepEqual(next, { key: "todos", lines: ["a", "b"] });
  assert.deepEqual(applyWidgetEvent(next, "plan", ["c"]), { key: "plan", lines: ["c"] });
});

test("undefined clears the single current widget regardless of key", () => {
  const current = { key: "todos", lines: ["a"] };
  assert.equal(applyWidgetEvent(current, "todos"), null);
  assert.equal(applyWidgetEvent(current, "other"), null);
});

test("an empty frame preserves the current widget", () => {
  const current = { key: "todos", lines: ["a"] };
  assert.equal(applyWidgetEvent(current, "todos", []), current);
  assert.equal(applyWidgetEvent(current, "other", []), current);
});
