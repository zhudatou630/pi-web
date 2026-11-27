import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createJiti } from "jiti";

const root = fileURLToPath(new URL("../", import.meta.url));
const { menuEscapeFocusTarget } = await createJiti(import.meta.url, { alias: { "@/": root }, jsx: true }).import("./useMenuDismiss.ts");

// A menu root holding its trigger and (while open) a menu item.
function fixture() {
  const trigger = { name: "trigger" };
  const item = { name: "item" };
  const body = { name: "body" };
  const outside = { name: "outside" };
  const menuRoot = {
    contains: (node) => node === menuRoot || node === trigger || node === item,
    querySelector: (selector) => (selector === "[aria-expanded]" ? trigger : null),
  };
  return { trigger, item, body, outside, menuRoot };
}

test("Escape gives focus back to the menu's trigger from inside the menu or from the page", () => {
  const { trigger, item, body, menuRoot } = fixture();
  assert.equal(menuEscapeFocusTarget(menuRoot, item, body), trigger);
  assert.equal(menuEscapeFocusTarget(menuRoot, trigger, body), trigger);
  // A pick unmounted the focused row: focus fell to the page.
  assert.equal(menuEscapeFocusTarget(menuRoot, body, body), trigger);
  assert.equal(menuEscapeFocusTarget(menuRoot, null, body), trigger);
});

test("Escape leaves focus the user moved elsewhere where it is", () => {
  const { body, outside, menuRoot } = fixture();
  assert.equal(menuEscapeFocusTarget(menuRoot, outside, body), null);
  assert.equal(menuEscapeFocusTarget(null, body, body), null);
});
