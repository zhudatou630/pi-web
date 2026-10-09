import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { createJiti } from "jiti";

const { projectDragDecision, projectDropAt, PROJECT_LONG_PRESS_MS } = await createJiti(import.meta.url).import("./useProjectDrag.ts");

test("mouse threshold and touch/pen hold distinguish taps, scrolling, menus, and drags", () => {
  assert.equal(PROJECT_LONG_PRESS_MS, 400);
  assert.equal(projectDragDecision("mouse", "pending", 3.99), "pending");
  assert.equal(projectDragDecision("mouse", "pending", 4), "dragging");
  for (const pointer of ["touch", "pen"]) {
    assert.equal(projectDragDecision(pointer, "pending", 4), "pending", "no drag before the hold");
    assert.equal(projectDragDecision(pointer, "pending", 10), "pending");
    assert.equal(projectDragDecision(pointer, "pending", 10.01), "cancel", "swiping still scrolls");
    assert.equal(projectDragDecision(pointer, "armed", 0), "armed", "release opens menu, not a drag");
    assert.equal(projectDragDecision(pointer, "armed", 3.99), "armed");
    assert.equal(projectDragDecision(pointer, "armed", 4), "dragging", "movement after hold replaces the menu");
    assert.equal(projectDragDecision(pointer, "dragging", 0), "dragging");
  }
});

test("drop lines use whole group boundaries, not session rows or the mounted virtual window", () => {
  const blocks = [
    { key: "a", top: 0, bottom: 26 },
    { key: "b", top: 26, bottom: 26 * 22 }, // Expanded, mostly outside the viewport.
    { key: "c", top: 26 * 22, bottom: 26 * 23 },
  ];
  const allowedLines = new Set(blocks.flatMap((block) => [block.top, block.bottom]));
  for (let y = -100; y < 26 * 25; y += 3) {
    const drop = projectDropAt(blocks, "a", y);
    assert.ok(allowedLines.has(drop.lineY));
    assert.notEqual(drop.anchor, "a");
  }
  assert.deepEqual(projectDropAt(blocks, "a", 26 * 20), { anchor: "c", position: "before", lineY: 26 * 22 });
  assert.deepEqual(projectDropAt(blocks, "a", 10000), { anchor: "c", position: "after", lineY: 26 * 23 });
  assert.deepEqual(projectDropAt(blocks, "c", -10), { anchor: "a", position: "before", lineY: 0 });
  assert.equal(projectDropAt([blocks[0]], "a", 20), null);
  const dropdown = ["a", "b", "c"].map((key, i) => ({ key, top: i * 28, bottom: (i + 1) * 28 }));
  assert.deepEqual(projectDropAt(dropdown, "c", 0), { anchor: "a", position: "before", lineY: 0 });
  assert.deepEqual(projectDropAt(dropdown, "a", 100), { anchor: "c", position: "after", lineY: 84 });
});

// Exercise native listeners without a DOM/server or real user state.
const hookSource = await readFile(new URL("./useProjectDrag.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(hookSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
function gestureHarness(t) {
  const window = new EventTarget();
  const document = Object.assign(new EventTarget(), { visibilityState: "visible" });
  const timers = new Map();
  const frames = new Map();
  const effects = [];
  let nextId = 0;
  let view = null;
  const scroll = { scrollTop: 0, clientHeight: 78, scrollHeight: 1000,
    getClientRects: () => [1], getBoundingClientRect: () => ({ top: 0, bottom: 78 }),
    setPointerCapture() {}, releasePointerCapture() {} };
  const row = { closest: () => null };
  const moves = [], menus = [], dragging = [];
  const exports = {};
  runInNewContext(compiled, {
    exports, window, document, navigator: {},
    setTimeout(fn) { const id = ++nextId; timers.set(id, fn); return id; }, clearTimeout(id) { timers.delete(id); },
    requestAnimationFrame(fn) { const id = ++nextId; frames.set(id, fn); return id; }, cancelAnimationFrame(id) { frames.delete(id); },
    require(name) {
      assert.equal(name, "react");
      return { useRef: (current) => ({ current }), useMemo: (fn) => fn(),
        useState: () => [view, (value) => { view = typeof value === "function" ? value(view) : value; }],
        useEffect: (fn) => effects.push(fn), useLayoutEffect: (fn) => effects.push(fn) };
    },
  });
  const api = exports.useProjectDrag({ enabled: true, allowDrag: true,
    blocks: ["a", "b", "c"].map((key, i) => ({ key, top: i * 26, bottom: (i + 1) * 26 })),
    scrollRef: { current: scroll }, innerRef: { current: { getBoundingClientRect: () => ({ top: -scroll.scrollTop }) } },
    onMove: (...args) => moves.push(args), onMenu: (...args) => menus.push(args), onDrag: (key) => dragging.push(key),
  });
  const cleanups = effects.map((fn) => fn());
  t.after(() => cleanups.forEach((fn) => fn?.()));
  const emit = (type, fields = {}, target = window) => {
    const event = Object.assign(new Event(type, { cancelable: true }), { pointerId: 1, isPrimary: true, buttons: 1, clientX: 20, clientY: 10, ...fields });
    target.dispatchEvent(event);
    return event;
  };
  const down = (pointerType = "mouse", fields = {}) => {
    emit("pointerdown", fields);
    api.onPointerDown({ pointerId: 1, pointerType, isPrimary: true, button: 0, clientX: 20, clientY: 10,
      target: row, currentTarget: row, ...fields }, "a");
  };
  const hold = () => { const callbacks = [...timers.values()]; timers.clear(); callbacks.forEach((fn) => fn()); };
  const frame = () => { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach((fn) => fn()); };
  const click = () => { const event = new Event("click", { cancelable: true }); api.onClickCapture(event); return event.defaultPrevented; };
  return { api, down, hold, frame, click, emit, document, moves, menus, dragging, scroll, timers, frames, view: () => view };
}

test("real hook listeners leave clicks alone and defer a stationary long-press menu until release", (t) => {
  const h = gestureHarness(t);
  h.down();
  h.emit("pointermove", { clientX: 23.9 });
  h.emit("pointerup");
  assert.equal(h.click(), false, "a row click must still toggle");
  h.down("touch");
  h.hold();
  assert.equal(h.menus.length, 0, "holding must not open a menu that would block movement");
  assert.equal(h.emit("contextmenu").defaultPrevented, true);
  h.emit("pointerup");
  assert.deepEqual(h.menus, [["a", 20, 10]]);
  assert.equal(h.click(), true, "long-press release must not toggle the row");
  assert.equal(h.moves.length, 0);
});

test("touch hold-then-move drags instead of opening a menu, prevents scrolling, and auto-scrolls at the edge", (t) => {
  const h = gestureHarness(t);
  h.down("touch");
  h.hold();
  const event = h.emit("touchmove", { touches: [{ clientX: 20, clientY: 77 }] });
  assert.equal(event.defaultPrevented, true);
  assert.deepEqual(h.dragging, ["a"]);
  h.frame();
  assert.ok(h.scroll.scrollTop > 0);
  assert.equal(h.view().key, "a");
  h.emit("pointerup", { clientY: 77 });
  assert.deepEqual(h.moves, [["a", "c", "after"]]);
  assert.equal(h.menus.length, 0);
  assert.equal(h.click(), true);
  assert.equal(h.frames.size, 0);
});

test("swipes, Escape, second fingers, and hidden tabs cancel without moves or menus", (t) => {
  const h = gestureHarness(t);
  h.down("touch");
  h.emit("touchmove", { touches: [{ clientX: 20, clientY: 21 }] });
  assert.equal(h.timers.size, 0);
  h.hold();
  h.emit("pointerup");
  assert.equal(h.menus.length, 0);
  for (const cancel of [
    () => h.emit("keydown", { key: "Escape" }),
    () => { h.emit("pointerdown", { pointerId: 2, isPrimary: false }); h.api.onPointerDown({ isPrimary: false }, "b"); },
    () => { h.document.visibilityState = "hidden"; h.emit("visibilitychange", {}, h.document); },
  ]) {
    h.document.visibilityState = "visible";
    h.down();
    h.emit("pointermove", { clientX: 24 });
    assert.equal(h.view().key, "a");
    cancel();
    h.emit("pointerup");
    assert.equal(h.view(), null);
    assert.equal(h.click(), true, "cancelled release cannot toggle, even after a long wait");
    assert.equal(h.frames.size, 0);
  }
  assert.equal(h.moves.length, 0);
  assert.equal(h.menus.length, 0);
});
