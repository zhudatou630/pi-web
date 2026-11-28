import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const appShell = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
const chatWindow = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");
const agentSession = await readFile(new URL("../hooks/useAgentSession.ts", import.meta.url), "utf8");

test("a finished tool that can write asks the explorer to reload; read-only tools do not", () => {
  assert.match(appShell, /import \{ PRESET_READ_ONLY, type ToolEntry \} from "@\/lib\/tool-presets";/);
  assert.match(appShell, /const READ_ONLY_TOOL_NAMES = new Set\(PRESET_READ_ONLY\);/);
  assert.match(
    appShell,
    /const handleToolEnd = useCallback\(\(toolName: string\) => \{\s*if \(!READ_ONLY_TOOL_NAMES\.has\(toolName\)\) requestExplorerRefresh\(\);/,
  );
});

test("explorer reloads are coalesced to one a second, shared by every chat pane", () => {
  assert.match(appShell, /const EXPLORER_REFRESH_MS = 1000;/);
  assert.match(appShell, /const explorerRefreshTimerRef = useRef/);
  assert.match(appShell, /if \(explorerRefreshTimerRef\.current\) return;/);
  assert.match(
    appShell,
    /explorerRefreshTimerRef\.current = setTimeout\(\(\) => \{\s*explorerRefreshTimerRef\.current = null;\s*setExplorerRefreshKey\(\(k\) => k \+ 1\);\s*\}, EXPLORER_REFRESH_MS\);/,
  );
});

test("window focus requests the same coalesced reload and is cleaned up on unmount", () => {
  assert.match(appShell, /window\.addEventListener\("focus", requestExplorerRefresh\);/);
  assert.match(appShell, /window\.removeEventListener\("focus", requestExplorerRefresh\);/);
  assert.match(appShell, /if \(explorerRefreshTimerRef\.current\) clearTimeout\(explorerRefreshTimerRef\.current\);/);
});

test("the shell hands one tool-end callback to every chat pane through ChatWindow", () => {
  assert.match(appShell, /onToolEnd=\{handleToolEnd\}/);
  assert.match(chatWindow, /onToolEnd\?: \(toolName: string\) => void;/);
  assert.match(chatWindow, /onAgentEnd, onToolEnd, onFilesChanged, onAttentionNeeded/);
  assert.match(chatWindow, /onAgentEnd: wrappedOnAgentEnd, onToolEnd,/);
});

test("chat file-change prop invokes the shared coalesced explorer refresh", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const file = ts.createSourceFile("AppShell.tsx", appShell, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  function find(node, predicate) {
    if (predicate(node)) return node;
    return ts.forEachChild(node, (child) => find(child, predicate));
  }
  function evaluate(node, scope) {
    const js = ts.transpileModule(`return (${node.getText(file)});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    return new Function(...Object.keys(scope), js)(...Object.values(scope));
  }
  const declaration = find(file, (node) => ts.isVariableDeclaration(node) && node.name.getText(file) === "requestExplorerRefresh");
  const interval = find(file, (node) => ts.isVariableDeclaration(node) && node.name.getText(file) === "EXPLORER_REFRESH_MS");
  let refreshKey = 0;
  const requestExplorerRefresh = evaluate(declaration.initializer.arguments[0], {
    explorerRefreshTimerRef: { current: null }, setTimeout,
    EXPLORER_REFRESH_MS: evaluate(interval.initializer, {}),
    setExplorerRefreshKey: (update) => { refreshKey = update(refreshKey); },
  });
  const chat = find(file, (node) => ts.isJsxSelfClosingElement(node) && node.tagName.getText(file) === "ChatWindow");
  const prop = chat.attributes.properties.find((node) => ts.isJsxAttribute(node) && node.name.getText(file) === "onFilesChanged");
  assert.ok(prop, "all chat panes need the file-change prop");
  const onFilesChanged = evaluate(prop.initializer.expression, { requestExplorerRefresh });
  assert.equal(onFilesChanged, requestExplorerRefresh);
  onFilesChanged(); onFilesChanged(); requestExplorerRefresh();
  assert.equal(refreshKey, 0);
  t.mock.timers.tick(1000);
  assert.equal(refreshKey, 1);
  onFilesChanged();
  t.mock.timers.tick(1000);
  assert.equal(refreshKey, 2);
});

test("useAgentSession reports each finished tool call with its name", () => {
  assert.match(
    agentSession,
    /case "tool_execution_end": \{\s*const id = event\.toolCallId as string;\s*onToolEnd\?\.\(event\.toolName as string\);/,
  );
});

test("the file panel follows the shown session on every path, not only sidebar clicks", () => {
  assert.match(appShell, /const shownKey = selectedSession \? `session:\$\{selectedSession\.id\}`/);
  // During render, in the switch's own commit.
  assert.match(appShell, /if \(shownKey && shownCwd && followedShownKey !== shownKey\) \{\s*setFollowedShownKey\(shownKey\);[\s\S]{0,400}shouldAdoptSessionCwd\(/);
  // A cwd change must not hand every chat a new onOpenFile (it re-rendered all their Markdown).
  assert.match(appShell, /const handleOpenFile = useCallback\([\s\S]*?\}, \[isMobile, openRightPanelAfterRender\]\);/);
});
