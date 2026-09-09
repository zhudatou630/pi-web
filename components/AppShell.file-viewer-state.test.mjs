import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");

function fileContentBlock() {
  const start = source.indexOf("{/* Only the active viewer");
  const end = source.indexOf("</div>\n      </div>\n    </div>", start);
  assert.notEqual(start, -1, "file content comment not found");
  assert.notEqual(end, -1, "end of file content block not found");
  return source.slice(start, end);
}

test("only the active file tab mounts a FileViewer", () => {
  const block = fileContentBlock();
  assert.match(block, /activeFileTab\?\.filePath \? \(/);
  assert.doesNotMatch(block, /fileTabs\.map\(/);
  assert.equal(block.match(/<FileViewer/g)?.length, 1);
});

test("the active viewer restores tab state and saves it with a revision", () => {
  const block = fileContentBlock();
  assert.match(block, /key=\{`\$\{activeFileTab\.id\}:\$\{activeFileTab\.viewerRevision \?\? 0\}`\}/);
  assert.match(block, /cwd=\{activeFileTab\.cwd \?\? activeCwd \?\? undefined\}/);
  assert.match(block, /initialState=\{activeFileTab\.viewerState\}/);
  assert.match(block, /handleFileViewerStateChange\(\s*activeFileTab\.id,\s*activeFileTab\.viewerRevision \?\? 0,/);
  assert.match(block, /onMentionLines=\{rightPanelOpen \? handleFileLineMention : undefined\}/);
});

test("file mentions carry their source cwd into the focused chat", () => {
  assert.match(source, /function pathForChatMention/);
  assert.match(source, /pathForChatMention\(relativePath, sourceCwd, getFocusedChatCwd\(\)\)/);
  assert.match(source, /source === target[\s\S]*return joinFilePath\(sourceCwd, path\)/);
});

test("closing the file panel pauses the active viewer watcher", () => {
  assert.match(source, /watchEnabled=\{fileWatchEnabled\}/);
  assert.match(source, /setFileWatchEnabled\(false\)/);
  assert.match(source, /addEventListener\("transitionend", onTransitionEnd\)/);
});

test("a closed file panel is removed from keyboard and accessibility navigation", () => {
  assert.match(source, /aria-hidden=\{!rightPanelOpen\}/);
  assert.match(source, /inert=\{!rightPanelOpen \? true : undefined\}/);
});

test("the file panel restores focus to its actual toolbar toggle", () => {
  const toggleStart = source.indexOf("const renderMainFileToggle");
  const toggleEnd = source.indexOf("\n  };", toggleStart);
  assert.notEqual(toggleStart, -1);
  assert.match(source.slice(toggleStart, toggleEnd), /ref=\{filePanelToggleRef\}/);
});
