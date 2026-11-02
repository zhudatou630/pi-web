import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("offers compact quoting controls and sends branch questions through the main chat", async () => {
  const chatSource = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");
  const shellSource = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");

  assert.match(chatSource, /onPointerUp=\{captureQuotedSelection\}/);
  assert.match(chatSource, /ownChatInputRef\.current\?\.addQuote\(\{ text: quotedSelection\.text, source: quotedSelection\.source \}\)/);
  assert.match(chatSource, /closest<HTMLElement>\("\.quote-chip-body"\)/);
  // During a run the side chat forks from the server's live leaf, not the view's.
  assert.match(chatSource, /onAskInSideChat\(prompt, sourceSessionId, sessionBusy \? null : activeLeafId\)/);
  assert.match(chatSource, /onAskInSideChat\(question, sourceSessionId, sessionBusy \? null : activeLeafId\)/);
  assert.match(shellSource, /type: "fork_branch",\s*side: true,/);
  assert.match(shellSource, /initialPrompt=\{pendingQuotePrompt\?\.sessionId === tabSession\?\.id/);
  assert.equal((shellSource.match(/<ChatWindow\b/g) ?? []).length, 1);
  assert.match(chatSource, /onInitialPromptConsumed\?\.\(targetSessionId\);\s*keepTabOpen\(\);\s*void handleSend\(initialPrompt\)/);
  assert.match(chatSource, /role=\{quoteInputOpen \? "dialog" : "toolbar"\}/);
});
