import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { formatAskUserAnswer, matchAskUserOptions, findAskUserAnswers } = await createJiti(import.meta.url).import("./ask-user-answer.ts");
const question = (...ids) => ({ role: "assistant", content: ids.map((id) => ({ type: "toolCall", toolCallId: id, toolName: "ask_user", input: {} })) });
const user = (content) => ({ role: "user", content });
const results = new Map(["a", "b", "c"].map((id) => [id, { role: "toolResult", toolCallId: id, details: {} }]));

test("formats selected labels as ordinary message lines and matches whole trimmed lines only", () => {
  assert.equal(formatAskUserAnswer(["中文", "English"]), "中文\nEnglish");
  assert.equal(formatAskUserAnswer([]), "");
  assert.deepEqual(matchAskUserOptions(["A", "B", "AB"], " B \r\nA\nA\nOther"), ["A", "B"]);
  assert.deepEqual(matchAskUserOptions(["A", "B"], "I prefer A"), []);
});

test("uses the first following user message, including text blocks and empty answers", () => {
  const state = findAskUserAnswers([
    question("a"), { role: "toolResult", toolCallId: "a", content: [] },
    user([{ type: "text", text: "A" }, { type: "image", data: "image" }, { type: "text", text: "B" }]),
    user("not the first answer"), question("b"), user(""), question("c"),
  ], results, true);
  assert.deepEqual([...state.answers], [["c", null], ["b", ""], ["a", "A\nB"]]);
  assert.equal(state.activeQuestionId, "c");
});

test("only the latest question can be active, never pending, running, answered or failed", () => {
  assert.equal(findAskUserAnswers([question("a", "b")], results, true).activeQuestionId, "b");
  assert.equal(findAskUserAnswers([question("a"), question("b")], results, false).activeQuestionId, null);
  assert.equal(findAskUserAnswers([question("a"), user("free answer")], results, true).activeQuestionId, null);
  assert.equal(findAskUserAnswers([question("a"), question("pending")], results, true).activeQuestionId, null);
  const failed = new Map([...results, ["b", { isError: true }]]);
  assert.equal(findAskUserAnswers([question("a", "b")], failed, true).activeQuestionId, null);
  assert.deepEqual([...findAskUserAnswers([user("hi")], results, true).answers], []);
});

test("an answer clicked on the card hides its bubble; typed, partial or image answers keep it", () => {
  const asked = (id, options) => ({ role: "assistant", content: [{ type: "toolCall", toolCallId: id, toolName: "ask_user", input: { options } }] });
  const state = findAskUserAnswers([
    asked("a", ["X", "Y", "Z"]), user("X\nZ"),
    asked("b", ["X", "Y"]), user("X, but cheaper"),
    asked("c", ["X", "Y"]), user([{ type: "text", text: "Y" }, { type: "image", data: "i" }]),
    asked("d", ["X", "Y"]), user("Y"), user("Y"),
    asked("e", ["X", "Y"]), user("X"),
    asked("f", ["X", "Y"]), user("Y"),
  ], new Map(["a", "b", "c", "d", "e"].map((id) => [id, { toolCallId: id, isError: id === "e", details: undefined }])), true);
  // e failed (no card, a plain error block) and f has no result yet: their answers keep the bubble.
  assert.deepEqual([...state.cardAnswerIndexes].sort(), [1, 7]);
});
