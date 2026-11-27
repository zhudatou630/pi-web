import assert from "node:assert/strict";
import test from "node:test";

const {
  SESSION_ROW_CONTEXT_MENU_EVENT,
  dispatchSessionRowContextMenu,
  placeContextMenu,
} = await import("./session-row-context-menu.ts");

function createDetail() {
  return {
    id: "session-1",
    path: "/tmp/session-1.jsonl",
    cwd: "/tmp/project",
    name: "Example session",
    clientX: 120,
    clientY: 80,
    refresh: () => {},
  };
}

test("leaves the native context menu unclaimed when no listener is installed", () => {
  const target = new EventTarget();
  assert.equal(dispatchSessionRowContextMenu(createDetail(), target), false);
});

test("delivers the stable session-row detail without requiring a listener to claim it", () => {
  const target = new EventTarget();
  const detail = createDetail();
  let received;
  target.addEventListener(SESSION_ROW_CONTEXT_MENU_EVENT, (event) => {
    received = event;
  });

  assert.equal(dispatchSessionRowContextMenu(detail, target), false);
  assert.equal(received.cancelable, true);
  assert.equal(received.detail, detail);
});

test("reports the menu as handled when a listener cancels the extension event", () => {
  const target = new EventTarget();
  target.addEventListener(SESSION_ROW_CONTEXT_MENU_EVENT, (event) => {
    event.preventDefault();
  });

  assert.equal(dispatchSessionRowContextMenu(createDetail(), target), true);
});

test("a long-press menu sits below the pressed row, above it without room, and stays in the viewport", () => {
  const base = { x: 250, y: 300, width: 200, height: 160, viewportWidth: 390, viewportHeight: 844 };
  const row = { top: 290, bottom: 322 };
  assert.deepEqual(placeContextMenu({ ...base, avoid: row }), { left: 182, top: 326 });
  assert.deepEqual(placeContextMenu({ ...base, y: 800, avoid: { top: 790, bottom: 822 } }), { left: 182, top: 626 });
  assert.deepEqual(placeContextMenu({ ...base, x: 0, avoid: row }).left, 8);
  // A pointer menu (right click) keeps the pointer position, clamped.
  assert.deepEqual(placeContextMenu({ ...base, x: 100, y: 100 }), { left: 102, top: 102 });
  assert.deepEqual(placeContextMenu({ ...base, y: 800 }), { left: 182, top: 676 });
});
