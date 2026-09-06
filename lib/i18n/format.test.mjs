import assert from "node:assert/strict";
import test from "node:test";

import { formatCompactRelativeTime, formatRelativeTime, interpolateMessage, translateMessage } from "./format.ts";

test("interpolates string and numeric parameters", () => {
  assert.equal(interpolateMessage("Hello, {name} ({count})", { name: "Pi", count: 2 }), "Hello, Pi (2)");
});

test("falls back to English and returns the key when both are missing", () => {
  assert.equal(translateMessage("zh-CN", "common.ok", { en: { "common.ok": "OK" }, "zh-CN": {} }), "OK");
  assert.equal(translateMessage("zh-CN", "missing.key", { en: {}, "zh-CN": {} }), "missing.key");
});

test("formats compact session ages without redundant suffixes", () => {
  const now = new Date("2026-01-01T00:00:00Z");
  for (const [minutes, en, cn, tw] of [
    [0, "now", "刚刚", "剛剛"],
    [1, "1m", "1分钟", "1分鐘"],
    [59, "59m", "59分钟", "59分鐘"],
    [60, "1h", "1小时", "1小時"],
    [120, "2h", "2小时", "2小時"],
    [1440, "1d", "1天", "1天"],
    [43200, "30d", "30天", "30天"],
  ]) {
    const date = new Date(now.getTime() - minutes * 60_000).toISOString();
    assert.equal(formatCompactRelativeTime(date, "en", now), en);
    assert.equal(formatCompactRelativeTime(date, "zh-CN", now), cn);
    assert.equal(formatCompactRelativeTime(date, "zh-TW", now), tw);
  }
});

test("formats relative time using the selected locale", () => {
  const now = new Date("2026-01-01T00:00:00.000Z");
  assert.equal(formatRelativeTime(new Date("2026-01-01T00:05:00.000Z"), "en", now), "in 5 minutes");
  assert.equal(formatRelativeTime(new Date("2025-12-31T23:00:00.000Z"), "zh-CN", now), "1小时前");
  assert.equal(formatRelativeTime(new Date("2025-12-31T23:00:00.000Z"), "zh-TW", now), "1 小時前");
});
