import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const {
  handleGlobalShortcutKeyDown,
  isComposerKeyboardTarget,
  registerAbortHandler,
} = await createJiti(import.meta.url).import("./useKeyboardShortcuts.ts");

function keyEvent(key, extra = {}) {
  return {
    key,
    ctrlKey: Boolean(extra.ctrlKey),
    altKey: Boolean(extra.altKey),
    defaultPrevented: false,
    target: extra.target ?? { tagName: "BUTTON" },
    preventDefault() {
      this.defaultPrevented = true;
    },
    stopPropagation() {},
  };
}

test("Escape on a non-input target aborts, but consumed events and composer inputs do not", () => {
  let aborted = 0;
  const abort = () => { aborted += 1; };

  const consumed = keyEvent("Escape");
  consumed.preventDefault();
  handleGlobalShortcutKeyDown(consumed, { abortHandler: abort });
  assert.equal(aborted, 0);
  assert.equal(consumed.defaultPrevented, true);

  const inTextarea = keyEvent("Escape");
  inTextarea.target = { tagName: "TEXTAREA" };
  handleGlobalShortcutKeyDown(inTextarea, { abortHandler: abort });
  assert.equal(aborted, 0);
  assert.equal(isComposerKeyboardTarget({ tagName: "INPUT" }), true);

  const openLayer = keyEvent("Escape");
  handleGlobalShortcutKeyDown(openLayer, { abortHandler: abort });
  assert.equal(aborted, 1);
  assert.equal(openLayer.defaultPrevented, true);
});

test("an old abort registration cannot clear the focused pane handler", () => {
  const calls = [];
  const clearOld = registerAbortHandler(() => calls.push("old"));
  const clearFocused = registerAbortHandler(() => calls.push("focused"));

  clearOld();
  handleGlobalShortcutKeyDown(keyEvent("Escape"));
  assert.deepEqual(calls, ["focused"]);

  clearFocused();
  handleGlobalShortcutKeyDown(keyEvent("Escape"));
  assert.deepEqual(calls, ["focused"]);
});

test("a settings-style Escape closer stops abort on the same event", () => {
  let closed = 0;
  let aborted = 0;
  const event = keyEvent("Escape");
  const closeSettings = (e) => {
    if (e.key !== "Escape" || e.defaultPrevented) return;
    e.preventDefault();
    e.stopPropagation();
    closed += 1;
  };

  closeSettings(event);
  handleGlobalShortcutKeyDown(event, { abortHandler: () => { aborted += 1; } });
  assert.equal(closed, 1);
  assert.equal(aborted, 0);

  const idle = keyEvent("Escape");
  handleGlobalShortcutKeyDown(idle, { abortHandler: () => { aborted += 1; } });
  assert.equal(aborted, 1);
});

test("already-consumed non-Escape shortcuts are not repeated", () => {
  let created = 0;
  const event = keyEvent("n", { ctrlKey: true, altKey: true });
  event.preventDefault();
  handleGlobalShortcutKeyDown(event, {
    activeCwd: "/tmp",
    onNewSession: () => { created += 1; },
  });
  assert.equal(created, 0);

  const fresh = keyEvent("n", { ctrlKey: true, altKey: true });
  handleGlobalShortcutKeyDown(fresh, {
    activeCwd: "/tmp",
    onNewSession: () => { created += 1; },
  });
  assert.equal(created, 1);
});
