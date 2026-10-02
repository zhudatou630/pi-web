import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

const modal = await readFile(new URL("./ModalDialog.tsx", import.meta.url), "utf8");
const confirm = await readFile(new URL("../hooks/useConfirm.ts", import.meta.url), "utf8");

test("ModalDialog leaves focus, inertness, and layering to a native modal <dialog>", () => {
  assert.match(modal, /dialog\.showModal\(\)/);
  // Escape handled by a nested control stays there, and never reaches an outer dialog.
  assert.match(modal, /event\.key !== "Escape" \|\| event\.defaultPrevented \|\| event\.nativeEvent\.isComposing/);
  assert.match(modal, /event\.preventDefault\(\);[^\n]*\n\s*event\.stopPropagation\(\);/);
  assert.match(modal, /if \(event\.target !== event\.currentTarget\) return;/);
  // A dialog whose owner withholds onClose is reopened if the browser closes it anyway.
  assert.match(modal, /else dialog\.showModal\(\);/);
  assert.match(modal, /opener\?\.isConnected \? opener :/);
});

test("confirms are app dialogs that start on Cancel when destructive", () => {
  assert.match(confirm, /document\.createElement\("dialog"\)/);
  assert.match(confirm, /\(danger && cancel \? cancel : ok\)\.focus\(\)/);
  assert.match(confirm, /resolve\(dialog\.returnValue === "ok"\)/);
});

test("no component uses the browser's native confirm or alert", async () => {
  const files = [];
  for (const dir of ["./", "./models/"]) {
    for (const name of await readdir(new URL(dir, import.meta.url))) {
      if (name.endsWith(".tsx")) files.push(new URL(dir + name, import.meta.url));
    }
  }
  for (const file of files) {
    assert.doesNotMatch(await readFile(file, "utf8"), /window\.(confirm|alert)\(/, file.pathname);
  }
});
