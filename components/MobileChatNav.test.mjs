import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const chatWindowSource = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");
const mobileNavSource = await readFile(new URL("./MobileChatNav.tsx", import.meta.url), "utf8");
const appShellSource = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
const chatInputSource = await readFile(new URL("./ChatInput.tsx", import.meta.url), "utf8");

test("unifies scroll-to-bottom button without persistent floating outline in chat window", () => {
  assert.match(
    chatWindowSource,
    /\{showScrollBottom && !pendingScrollRestore && \(/,
  );
  assert.doesNotMatch(
    chatWindowSource,
    /showScrollBottom=\{showScrollBottom\}/,
  );
});

test("syncs mobile outline data into the shared top panel instead of a portal sheet", () => {
  assert.match(
    chatWindowSource,
    /<MobileOutlineSync[\s\S]*?onJumpToEntry=\{jumpToOutlineEntry\}/,
  );
  assert.match(mobileNavSource, /export function MobileOutlineList/);
  assert.match(mobileNavSource, /useEffect\(\(\) => \(\) => \{ onChange\?\.\(null\); \}, \[onChange\]\)/);
  assert.match(mobileNavSource, /chatMinimap\.empty/);
  assert.match(mobileNavSource, /root\.scrollTop \+= row\.bottom - box\.bottom/);
  assert.doesNotMatch(mobileNavSource, /\.scrollIntoView\(/);
  assert.match(mobileNavSource, /maxHeight: "inherit"/);
  assert.doesNotMatch(mobileNavSource, /block: "center"/);
  assert.doesNotMatch(mobileNavSource, /createPortal|pi-toggle-outline|session-sheet-pop/);
});

test("provides outline trigger in mobile toolbar actions", () => {
  assert.match(appShellSource, /data-mobile-toolbar-action="outline"/);
  assert.match(appShellSource, /toggleTopPanel\("outline"\)/);
  assert.match(appShellSource, /aria-pressed=\{activeTopPanel === "outline"\}/);
  assert.match(appShellSource, /data-top-panel-trigger="outline"/);
  assert.match(appShellSource, /<MobileOutlineList view=\{outlineView \?\? \{ items: \[\], onJumpToEntry: async \(\) => \{\} \}\} onClose=\{closeTopPanel\} \/>/);
});

test("enables context usage stats in the composer dock on mobile and desktop", () => {
  assert.match(chatInputSource, /\{renderContextUsageWidget\(\)\}/);
  assert.match(chatInputSource, /if \(!contextUsage \|\| contextPercent === null\) return null;/);
});

test("keeps outline on the shared session sheet with system tools and session", () => {
  assert.match(
    appShellSource,
    /activeTopPanel === "system" \|\| activeTopPanel === "tools" \|\| activeTopPanel === "session" \|\| activeTopPanel === "outline"/,
  );
});
