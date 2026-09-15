import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const chatWindowSource = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");
const mobileNavSource = await readFile(new URL("./MobileChatNav.tsx", import.meta.url), "utf8");
const minimapSource = await readFile(new URL("./ChatMinimap.tsx", import.meta.url), "utf8");

test("preserves desktop scroll-to-bottom button and minimap exclusively for desktop", () => {
  assert.match(
    chatWindowSource,
    /\{!isMobile && showScrollBottom && !pendingScrollRestore && \(/,
  );
  assert.match(
    chatWindowSource,
    /\{!isVisiblePane \|\| isMobile \|\| pendingScrollRestore \? null : \(/,
  );
});

test("mounts MobileChatNav on mobile visible pane", () => {
  assert.match(
    chatWindowSource,
    /<MobileChatNav[\s\S]*?showScrollBottom=\{showScrollBottom\}[\s\S]*?onScrollToBottom=\{handleScrollToBottom\}[\s\S]*?onJumpToEntry=\{jumpToOutlineEntry\}/,
  );
});

test("reuses outline fetch hook across desktop and mobile from ChatMinimap", () => {
  assert.match(minimapSource, /export function useSessionOutline\(/);
  assert.match(mobileNavSource, /import \{ useSessionOutline \} from "\.\/ChatMinimap";/);
});

test("aligns nav buttons strictly to 28px square geometry with no shadow", () => {
  assert.match(mobileNavSource, /rounded-\[4px\] border border-\[color-mix\(in_srgb,var\(--border\)_75%,transparent\)\] bg-\[var\(--bg\)\]/);
  assert.match(mobileNavSource, /inline-flex h-7 w-7 items-center justify-center/);
  assert.doesNotMatch(mobileNavSource, /shadow/);
});

test("implements bottom sheet with accessible dialog, backdrop and entry selection", () => {
  assert.match(mobileNavSource, /role="dialog"/);
  assert.match(mobileNavSource, /aria-modal="true"/);
  assert.match(mobileNavSource, /createPortal/);
  assert.match(mobileNavSource, /void onJumpToEntry\(item\.entryId\)/);
  assert.match(mobileNavSource, /setSheetOpen\(false\)/);
});
