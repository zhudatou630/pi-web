import assert from "node:assert/strict";
import test from "node:test";
import { countFaviconUnread, getFaviconBadge } from "./favicon-badge.ts";

test("the badge is amber with everything pending while a session waits, green with unread otherwise", () => {
  assert.equal(getFaviconBadge(0, 0), null);
  assert.deepEqual(getFaviconBadge(0, 3), { kind: "unread", count: 3 });
  assert.deepEqual(getFaviconBadge(1, 3), { kind: "awaiting", count: 4 });
  assert.deepEqual(getFaviconBadge(0, 250), { kind: "unread", count: 99 });
});

test("sessions that finished while hidden count once, beside the unread markers", () => {
  assert.equal(countFaviconUnread(new Set(["a", "b"]), new Set()), 2);
  assert.equal(countFaviconUnread(new Set(["a"]), new Set(["a", "visible"])), 2);
});
