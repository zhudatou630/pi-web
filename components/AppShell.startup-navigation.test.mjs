import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");

function callbackBody(name, nextName) {
  const start = source.indexOf(`const ${name} = useCallback`);
  const end = source.indexOf(`\n  const ${nextName}`, start);
  assert.notEqual(start, -1, `${name} callback not found`);
  assert.notEqual(end, -1, `${nextName} callback not found after ${name}`);
  return source.slice(start, end);
}

test("does not remember or restore a workspace's last session", () => {
  assert.doesNotMatch(source, /getLastOpenSession|setLastOpenSession|restoreWorkspaceContext|workspaceRestoreTokenRef/);
});

test("does not render a passive Get Started placeholder", () => {
  assert.doesNotMatch(source, /workspace\.getStarted|workspace\.selectProject|workspace\.addModels|showPlaceholder/);
});

test("switching projects prepares a fresh composer without an async session restore", () => {
  const callback = callbackBody("handleCwdChange", "handleSelectSession");
  assert.match(callback, /setSelectedSession\(null\)/);
  assert.match(callback, /setNewSessionDraftId\(draftId\)/);
  assert.doesNotMatch(callback, /fetch\("\/api\/sessions"\)|restoreWorkspaceContext/);
});

test("keeps chat scroll positions in page memory by session id", () => {
  assert.match(source, /useRef\(new Map<string, ChatScrollPosition>\(\)\)/);
  assert.match(source, /sessionScrollPositionsRef\.current\.set\(sessionId, position\)/);
  assert.match(source, /initialScrollPosition=\{tabSession \? sessionScrollPositionsRef\.current\.get\(tabSession\.id\) \?\? null : null\}/);
  assert.match(source, /onScrollPositionChange=\{handleSessionScrollPositionChange\}/);
  assert.doesNotMatch(source, /localStorage[^\n]*sessionScroll/i);
});

test("parking an unsent draft is independent of historical session restoration", () => {
  const selectSession = callbackBody("handleSelectSession", "handleNewSession");
  const newSession = callbackBody("handleNewSession", "hydrateSelectedSession");
  assert.match(selectSession, /rekeyDraft\(activeDraftKey, parkedNewSessionDraftKey\(activeDraftCwd\)\)/);
  assert.match(newSession, /rekeyDraft\(parkedNewSessionDraftKey\(cwd\), draftKey\)/);
});
