import assert from "node:assert/strict";
import test from "node:test";
import { countFaviconUnread, getFaviconBadge } from "./favicon-badge.ts";
import { unseenErrorSessionIds } from "./session-status.ts";

test("the badge is amber with everything pending while a session waits, green with unread otherwise", () => {
  assert.equal(getFaviconBadge(0, 0, 0), null);
  assert.deepEqual(getFaviconBadge(0, 0, 3), { kind: "unread", count: 3 });
  assert.deepEqual(getFaviconBadge(1, 0, 3), { kind: "awaiting", count: 4 });
  assert.deepEqual(getFaviconBadge(0, 0, 250), { kind: "unread", count: 99 });
  // An unseen error outranks unread and counts like it; waiting still comes first.
  assert.deepEqual(getFaviconBadge(0, 2, 3), { kind: "error", count: 5 });
  assert.deepEqual(getFaviconBadge(1, 2, 0), { kind: "awaiting", count: 3 });
});

test("sessions that finished while hidden count once, beside the unread markers", () => {
  assert.equal(countFaviconUnread(new Set(["a", "b"]), new Set()), 2);
  assert.equal(countFaviconUnread(new Set(["a"]), new Set(["a", "visible"])), 2);
  // A failed run is usually unread too: counted once, as an error.
  assert.equal(countFaviconUnread(new Set(["failed", "a"]), new Set(["failed"]), new Set(["failed"])), 1);
});

test("a failed on-screen session in a hidden tab marks the favicon as an error, not unread", () => {
  const sessions = [{ id: "split-a", lastError: { at: 100, message: "boom" } }, { id: "split-b", lastError: { at: 100, message: "boom" } }];
  const badgeFor = (visible) => {
    const errors = unseenErrorSessionIds(sessions, {}, new Set(), new Set(visible));
    return getFaviconBadge(0, errors.size, countFaviconUnread(new Set(), new Set(["split-a", "split-b"]), errors));
  };
  // Not attended: the sidebar passes no visible ids, so both failures stay unseen errors.
  assert.deepEqual(badgeFor([]), { kind: "error", count: 2 });
  // Attended: both panes are being read, so only the hidden-completion unread count remains.
  assert.deepEqual(badgeFor(["split-a", "split-b"]), { kind: "unread", count: 2 });
});
