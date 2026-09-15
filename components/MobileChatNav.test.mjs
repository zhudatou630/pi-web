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

test("mounts MobileChatNav on mobile visible pane for top-bar toggle", () => {
  assert.match(
    chatWindowSource,
    /<MobileChatNav[\s\S]*?onJumpToEntry=\{jumpToOutlineEntry\}/,
  );
  assert.match(mobileNavSource, /window\.addEventListener\("pi-toggle-outline"/);
});

test("provides outline trigger in mobile toolbar actions", () => {
  assert.match(appShellSource, /data-mobile-toolbar-action="outline"/);
  assert.match(appShellSource, /window\.dispatchEvent\(new CustomEvent\("pi-toggle-outline"\)\)/);
});

test("enables context usage stats in bottom input toolbar across mobile and desktop", () => {
  assert.match(chatInputSource, /renderContextUsageWidget\(true\)/);
  assert.match(chatInputSource, /renderContextUsageWidget\(false\)/);
});

test("implements bottom sheet with accessible dialog, backdrop and entry selection", () => {
  assert.match(mobileNavSource, /role="dialog"/);
  assert.match(mobileNavSource, /aria-modal="true"/);
  assert.match(mobileNavSource, /createPortal/);
  assert.match(mobileNavSource, /void onJumpToEntry\(item\.entryId\)/);
  assert.match(mobileNavSource, /setSheetOpen\(false\)/);
});
