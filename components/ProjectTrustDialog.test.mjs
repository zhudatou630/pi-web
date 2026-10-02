import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./ProjectTrustDialog.tsx", import.meta.url), "utf8");

test("the trust dialog is a modal that cannot be dismissed while trusting", () => {
  assert.match(source, /<ModalDialog/);
  assert.match(source, /onClose=\{busy \? undefined : onCancel\}/);
  assert.match(source, /focusFallback='\[data-dialog-focus-fallback="true"\]'/);
  assert.match(source, /<button autoFocus type="button"[^>]*onClick=\{onCancel\}/);
});
