import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./ProjectTrustDialog.tsx", import.meta.url), "utf8");

test("traps focus in the trust dialog and restores the trigger", () => {
  assert.match(source, /const previousFocus = document\.activeElement/);
  assert.match(source, /cancelRef\.current\?\.focus\(\)/);
  assert.match(source, /previousFocus\?\.isConnected/);
  assert.match(source, /data-dialog-focus-fallback/);
  assert.match(source, /event\.key === "Escape" && !busy/);
  assert.match(source, /querySelectorAll<HTMLButtonElement>\("button:not\(:disabled\)"\)/);
  assert.match(source, /if \(busy\) dialogRef\.current\?\.focus\(\)/);
  assert.match(source, /tabIndex=\{-1\}/);
  assert.match(source, /document\.activeElement === first/);
  assert.match(source, /document\.activeElement === dialogRef\.current/);
  assert.match(source, /document\.activeElement === last/);
});