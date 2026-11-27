import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");
const hookSource = await readFile(new URL("../hooks/useAgentSession.ts", import.meta.url), "utf8");

test("loading keeps the composer and does not report stats until ready", () => {
  const loading = source.slice(source.indexOf("if (loading)"), source.indexOf("if (error)"));
  assert.match(loading, /chat\.loadingSession/);
  assert.match(loading, /chatInputElement/);
  assert.match(source, /if \(loading\) return;\s*onSessionStatsChange\?\.\(sessionStatsRef\.current\)/);
  assert.match(source, /sessionStats\.contextUsage\?\.percent \?\? "null"/);
  assert.match(source, /sessionStats\.contextUsage\?\.contextWindow \?\? ""/);
  assert.match(source, /sessionStats\.contextUsage\?\.tokens \?\? "null"/);
});

test("scrolls notices inside the stationary transcript frame above the composer", () => {
  const noticeShelfUsages = source.match(/<NoticeShelf notices=/g) ?? [];

  assert.equal(noticeShelfUsages.length, 1);
  assert.match(
    source,
    /<div className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden">\s*<div\s+className="notice-shelf-wrapper"[\s\S]*?position: "absolute",\s*inset: 0,[\s\S]*?justifyContent: "flex-end",[\s\S]*?overflowY: "auto",\s*pointerEvents: "none",[\s\S]*?<NoticeShelf notices=/,
  );
});

test("keeps block-character art in a notice on a monospace grid, links still open (#755)", () => {
  assert.match(source, /function NoticeText[\s\S]*?splitNoticeText\(text\)\.map\(/);
  assert.match(source, /whiteSpace: "pre", fontFamily: "var\(--font-mono\)", lineHeight: 1/);
  assert.match(source, /function NoticeText[\s\S]*?const withLinks = \(value: string\) => splitNoticeLinks\(value\)[\s\S]*?target="_blank" rel="noopener noreferrer"/);
});

test("pauses only for a visible notice", () => {
  assert.match(
    hookSource,
    /noticeState\.visible\.some\(\(notice\) => notice\.id === pausedNoticeId\)\) return/,
  );
});

test("lets keyboard users pause and scroll long notices", () => {
  assert.match(source, /onFocus=\{\(\) => onPauseChange\?\.\(notice\.id\)\}/);
  assert.match(source, /onBlur=\{\(event\) => \{\s*if \(!event\.currentTarget\.matches\(":hover"\)\) onPauseChange\?\.\(null\)/);
  assert.match(source, /onMouseLeave=\{\(event\) => \{\s*if \(!event\.currentTarget\.contains\(document\.activeElement\)\) onPauseChange\?\.\(null\)/);
  assert.match(source, /<span\s+tabIndex=\{0\}\s+style=\{\{[^}]*overflowY: "auto"/);
});
