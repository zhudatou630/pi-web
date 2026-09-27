import assert from "node:assert/strict";
import test from "node:test";
import {
  findActiveUser, mapEntriesToUsers, markerIndexAt, markerWindow, minimapReadingLine, minimapTriggerHeight,
  revealOutlineEntry, outlineWindow, visibleMarkerCount,
} from "./chat-minimap.ts";

test("maps assistant/process groups to an unmounted user using loaded branch order", () => {
  const owners = mapEntriesToUsers(["u1", "u2", "u3"], ["unknown-prefix", "u1", "a1", "process1", "a2", "u2", "process2"]);
  assert.equal(owners.get("unknown-prefix"), undefined);
  assert.equal(owners.get("process1"), "u1");
  assert.equal(owners.get("a2"), "u1");
  assert.equal(owners.get("process2"), "u2");
  assert.equal(owners.get("u3"), "u3");
  assert.equal(mapEntriesToUsers(["u2"], ["u1", "a1", "u2", "a2"]).get("a1"), undefined);
});

test("continuous suffix inherits the preceding outline user, or the final turn if no user is loaded", () => {
  const users = ["u1", "u2", "u3"];
  const owners = mapEntriesToUsers(users, ["tool1001", "process", "u3", "answer"]);
  assert.equal(owners.get("tool1001"), "u2");
  assert.equal(owners.get("process"), "u2");
  assert.equal(owners.get("answer"), "u3");
  const tail = mapEntriesToUsers(users, ["tool1001", "process", "answer"]);
  for (const id of ["tool1001", "process", "answer"]) assert.equal(tail.get(id), "u3");
  assert.equal(mapEntriesToUsers([], ["tool"]).get("tool"), undefined);
});

test("binary reading-line lookup keeps a long answer active until the next user", () => {
  const anchors = [{ top: 0, userId: "u1" }, { top: 100, userId: "u1" }, { top: 4000, userId: "u2" }];
  assert.equal(findActiveUser([], 20), null);
  assert.equal(findActiveUser(anchors, -10), "u1");
  assert.equal(findActiveUser(anchors, 3999), "u1");
  assert.equal(findActiveUser(anchors, 4000), "u2");
  assert.equal(findActiveUser(anchors, 10000), "u2");
});

test("short last turn at the transcript tail activates the last user", () => {
  const anchors = [{ top: 0, userId: "u1" }, { top: 100, userId: "u1" }, { top: 400, userId: "u2" }];
  // Viewport 500, content 700: last user sits at 400, below the ordinary 48px reading line.
  assert.equal(findActiveUser(anchors, minimapReadingLine(50, 500, 700)), "u1");
  assert.equal(findActiveUser(anchors, 200 + 48), "u1");
  assert.equal(findActiveUser(anchors, minimapReadingLine(200, 500, 700)), "u2");
  assert.equal(minimapReadingLine(0, 700, 700), 48);
  // Tail zone is max(48px, 10% of the viewport): 50px here.
  assert.equal(minimapReadingLine(149, 500, 700), 197);
  assert.equal(minimapReadingLine(150, 500, 700), Number.POSITIVE_INFINITY);
  // Small viewports keep the 48px floor.
  assert.equal(minimapReadingLine(151, 200, 400), 199);
  assert.equal(minimapReadingLine(152, 200, 400), Number.POSITIVE_INFINITY);
});

test("closed hint stays compact and includes the current question, even with 10000 turns", () => {
  assert.deepEqual(markerWindow(0, -1), { start: 0, end: 0 });
  assert.deepEqual(markerWindow(3, 1), { start: 0, end: 3 });
  assert.deepEqual(markerWindow(10000, 5000), { start: 4993, end: 5008 });
  assert.deepEqual(markerWindow(10000, 9999), { start: 9985, end: 10000 });
  assert.deepEqual(markerWindow(10000, -1), { start: 0, end: 15 });
  assert.deepEqual(markerWindow(10000, 5000, 3), { start: 4999, end: 5002 });
});

test("tick count fits the available height and the pointer maps to the tick under it", () => {
  assert.equal(visibleMarkerCount(40, 360), 15);
  assert.equal(visibleMarkerCount(4, 360), 4);
  assert.equal(visibleMarkerCount(40, 52), 3);
  assert.equal(minimapTriggerHeight(15), 186);
  assert.equal(minimapTriggerHeight(1), 20);
  const range = { start: 20, end: 35 };
  assert.equal(markerIndexAt(0, range), 20);
  assert.equal(markerIndexAt(11.9, range), 20);
  assert.equal(markerIndexAt(12, range), 21);
  assert.equal(markerIndexAt(-5, range), 20);
  assert.equal(markerIndexAt(9999, range), 34);
  assert.equal(markerIndexAt(0, { start: 0, end: 0 }), null);
});

test("28px directory rows use a bounded window with wheel-sized overscan, including fractional/bottom scroll", () => {
  assert.deepEqual(outlineWindow(0, 0, 360), { start: 0, end: 0 });
  assert.deepEqual(outlineWindow(3, 0, 360), { start: 0, end: 3 });
  assert.deepEqual(outlineWindow(10000, 0, 360), { start: 0, end: 25 });
  assert.deepEqual(outlineWindow(10000, 180005, 360), { start: 6416, end: 6454 });
  assert.deepEqual(outlineWindow(10000, 999999, 360), { start: 9975, end: 10000 });
  assert.deepEqual(outlineWindow(10000, -100, 360), { start: 0, end: 25 });
});

test("keyboard navigation computes only the directory scroll offset", () => {
  assert.equal(revealOutlineEntry(5, 0, 360), 0);
  assert.equal(revealOutlineEntry(10, 0, 360), 0);
  assert.equal(revealOutlineEntry(15, 0, 360), 88);
  assert.equal(revealOutlineEntry(9999, 0, 360), 279640);
  assert.equal(revealOutlineEntry(4, 200, 360), 112);
  // Scrubbing keeps two neighbour rows in view before gliding.
  assert.equal(revealOutlineEntry(9, 0, 360, 2), 0);
  assert.equal(revealOutlineEntry(11, 0, 360, 2), 32);
  assert.equal(revealOutlineEntry(1, 100, 360, 2), 0);
});
