import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const source = fs.readFileSync(new URL("./AppShell.tsx", import.meta.url), "utf8");

test("未命名会话在首轮结束后会静默生成标题", () => {
  const completionSource = source.slice(
    source.indexOf("  const handleAgentEnd = useCallback"),
    source.indexOf("  const handleAttentionNeeded = useCallback"),
  );
  assert.match(completionSource, /isAutoSessionTitleEnabled\(\)/);
  assert.match(completionSource, /!targetSession\.name/);
  assert.match(completionSource, /targetSession\.relation\?\.kind !== "subagent"/);
  assert.match(completionSource, /handleAutoNameRef\.current\?\.\(\{ sessionId: targetId \}\)/);
  assert.doesNotMatch(source, /title\.generate/);
  assert.doesNotMatch(source, /data-mobile-toolbar-action=\{mobile \? "name" : undefined\}/);
});

test("会话落盘后会用服务端记录清除临时状态", () => {
  assert.match(source, /\{ \.\.\.prev, \.\.\.full, transient: full\.transient \?\? false \}/);
  assert.match(source, /if \(selectedSession\) hydrateSelectedSession\(selectedSession\.id\)/);
});

test("独立完成的任务不会被固定时间窗口吞掉通知", () => {
  assert.doesNotMatch(source, /lastNotifiedSessionCompletionAtRef|now - lastNotifiedAt < 2500/);
});
