import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { startFrameHistory, observeFrameHistory, stepFrameHistory, loadFrameHistory } = await jiti.import("./frame-history.ts");

const position = (state) => [state.back, state.forward];

test("a fresh frame can go neither back nor forward", () => {
  assert.deepEqual(position(startFrameHistory(3)), [0, 0]);
});

test("frame navigations enable Back; Back then enables Forward", () => {
  let state = observeFrameHistory(startFrameHistory(3), 5);
  assert.deepEqual(position(state), [2, 0]);
  state = stepFrameHistory(stepFrameHistory(state, -1), -1);
  assert.deepEqual(position(state), [0, 2]);
  assert.equal(stepFrameHistory(state, -1), state, "never steps past the frame's first page");
  state = stepFrameHistory(stepFrameHistory(stepFrameHistory(state, 1), 1), 1);
  assert.deepEqual(position(state), [2, 0], "Forward stops at the last entry");
});

test("a navigation after going back drops the forward entries", () => {
  let state = observeFrameHistory(startFrameHistory(1), 5);
  state = stepFrameHistory(stepFrameHistory(stepFrameHistory(state, -1), -1), -1);
  // At back 1, a new page replaces the 3 forward entries: length = base 1 + 1 + 1.
  state = observeFrameHistory(state, 3);
  assert.deepEqual(position(state), [2, 0]);
});

test("an unseen same-length navigation never lets Back pass the frame's first page", () => {
  let state = stepFrameHistory(observeFrameHistory(startFrameHistory(1), 2), -1);
  state = observeFrameHistory(state, 2);
  assert.deepEqual(position(state), [0, 1]);
});

test("a frame created after Back finds its start once a navigation drops the forward entries", () => {
  // Old frame: 4 pages after the Pi Web entry, stepped back twice (entry 3 of 5); then Reload.
  let state = startFrameHistory(5);
  assert.deepEqual(position(state), [0, 0]);
  // Its first navigation drops 2 entries and adds 1: length 4, so it left from entry 3.
  state = observeFrameHistory(state, 4);
  assert.deepEqual([state.base, ...position(state)], [3, 1, 0]);
});

test("unseen navigations never put the base behind the real start", () => {
  // At entry 3 of 5, two navigations between polls keep the length 5: the real start is entry 5.
  let state = startFrameHistory(5);
  state = observeFrameHistory(state, 6);
  assert.deepEqual([state.base, ...position(state)], [5, 1, 0]);
  // At the browser's cap the length stays put and Back stays off.
  assert.deepEqual(position(observeFrameHistory(startFrameHistory(50), 50)), [0, 0]);
});

test("a load that is neither a new page nor a step taken here forgets the position", () => {
  // 3 pages after the first, stepped back once by the panel.
  const state = stepFrameHistory(observeFrameHistory(startFrameHistory(1), 4), -1);
  assert.deepEqual(position(loadFrameHistory(state, 4, 4, true)), [2, 1], "the panel's own step");
  assert.deepEqual(position(loadFrameHistory(state, 5, 4, false)), [4, 0], "a new page");
  assert.deepEqual(position(loadFrameHistory(state, 4, 4, false)), [0, 0], "a reload or an unseen step");
});
