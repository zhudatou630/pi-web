import assert from "node:assert/strict";
import test from "node:test";
import { getMarkdownListContinuation } from "./markdown-list-continuation.ts";

const newline = (text) => {
  const caret = text.indexOf("|");
  const value = text.replace("|", "");
  const edit = getMarkdownListContinuation(value, caret, caret);
  return edit && value.slice(0, edit.start) + edit.text + "|" + value.slice(edit.end);
};

test("continues bullets, ordered/CJK items and unchecked tasks with indentation", () => {
  for (const [input, expected] of [
    ["- item|", "- item\n- |"], ["* item|", "* item\n* |"], ["+ item|", "+ item\n+ |"],
    ["9. item|", "9. item\n10. |"], ["01) item|", "01) item\n02) |"],
    ["1、第一项|", "1、第一项\n2、|"], ["1、 第一项|", "1、 第一项\n2、 |"],
    ["- [x] done|", "- [x] done\n- [ ] |"], ["1. [X] done|", "1. [X] done\n2. [ ] |"],
    ["parent\n   - child|", "parent\n   - child\n   - |"], ["1. first|second", "1. first\n2. |second"],
    ["- a\n- [ ] |", "- a\n|"], ["- a\n- [ ]|", "- a\n|"],
  ]) assert.equal(newline(input), expected, input);
});

test("leaves selections, fences, thematic breaks and non-list text unchanged", () => {
  for (const input of ["plain|", "-no space|", "1.5 meters|", "2020、2021年|", "---|", "* * *|", "- - -|", "|1. item", "1.| item", "```\n- code|", "~~~md\n1. code|", "````\n```\n- code|"]) {
    assert.equal(newline(input), null, input);
  }
  assert.equal(newline("```\ncode\n```\n- list|"), "```\ncode\n```\n- list\n- |");
  assert.equal(getMarkdownListContinuation("- selected", 2, 10), null);
});
