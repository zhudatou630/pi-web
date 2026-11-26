import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");
const dialogSource = source.slice(source.indexOf("function ExtensionDialog"));
const customSource = source.slice(source.indexOf("function ExtensionCustomPanel"));

test("docks extension dialogs above the composer; custom panels stay over the content", () => {
  assert.doesNotMatch(source, /function ExtensionRequestSheet/);
  // Dialogs (and the run error) go into ChatInput's attention slot, at the composer's width.
  assert.match(source, /attention=\{\([\s\S]*?<ExtensionDialog key=\{extensionDialog\.id\}[\s\S]*?<RunErrorTray/);
  assert.match(dialogSource, /className="composer-attention"/);
  assert.match(dialogSource, /className="extension-dialog extension-dialog-docked"/);
  assert.doesNotMatch(dialogSource.slice(0, dialogSource.indexOf("function ExtensionCustomPanel")), /position: "absolute"/);
  assert.match(
    source,
    /className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden"[\s\S]*?<ExtensionCustomPanel[\s\S]*?className="relative flex min-h-0 flex-col"[\s\S]*?{composerStack}/,
  );
  assert.match(customSource, /position: "absolute"[\s\S]*?inset: 0/);
  assert.match(customSource, /pointerEvents: "none"/);
  assert.doesNotMatch(source, /z-\[100\]|zIndex: 100/);
  assert.match(customSource, /maxHeight: "min\(760px, 100%\)"/);
});

test("the run error tray names the reason and only offers View output", () => {
  const tray = source.slice(source.indexOf("function RunErrorTray"), source.indexOf("type ExtensionDialogRequest"));
  assert.match(tray, /chat\.errorTag/);
  assert.match(tray, /chat\.viewOutput/);
  assert.doesNotMatch(tray, /retry|continue/i);
  assert.match(source, /lastMessage\.stopReason === "error" && !isAbortedAssistantError\(lastMessage\)/);
  assert.match(source, /session\.lastError\.at >= \(lastMessage\.timestamp \?\? 0\) \? session\.lastError\.message/);
});

test("adds collapse without replacing cancel", () => {
  assert.match(dialogSource, /setCollapsed\(true\)/);
  assert.match(dialogSource, /chat\.extensionCollapse/);
  assert.match(dialogSource, /chat\.cancel/);
  assert.doesNotMatch(dialogSource, /chat\.extensionSkip/);
});

test("resets collapse state when a new extension request arrives", () => {
  assert.match(source, /<ExtensionDialog key=\{extensionDialog.id\}/);
  assert.match(source, /<ExtensionCustomPanel key=\{extensionCustomUi.id\}/);
  assert.match(customSource, /if \(!collapsed\) inputRef.current\?\.focus\(\);\s*}, \[collapsed\]\)/);
});
