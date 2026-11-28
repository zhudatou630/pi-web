import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { noteTitle, notePreview, noteTaskCounts, toggleNoteTaskAt, groupNotesByTag, toggleTaskLines, continueTaskOnEnter } = await createJiti(import.meta.url).import("./note-text.ts");

test("note title, preview and todos", () => {
  const text = "\n# Release\n- [x] tests\n\n```md\n- [ ] not a task\n```\n1. [ ] changelog\n  * [X] nested";
  assert.equal(noteTitle(text), "Release");
  assert.equal(noteTitle("- [ ] buy milk\n- [x] eggs"), "buy milk");
  assert.equal(noteTitle("2. step"), "step");
  assert.equal(notePreview("one line"), "");
  assert.deepEqual(noteTaskCounts(text), { done: 2, total: 3 });
  assert.equal(toggleNoteTaskAt(text, text.indexOf("1. [ ]")), text.replace("1. [ ]", "1. [x]"));
  assert.equal(toggleNoteTaskAt(text, text.indexOf("* [X]")), text.replace("* [X]", "* [ ]"));
  assert.equal(toggleNoteTaskAt(text, 0), text);
  assert.equal(notePreview("t\n- [ ] a\nb"), "a b");
  // A quoted task renders a checkbox too, so it takes its place in the count.
  const quoted = "> - [ ] quoted\n> ```\n> - [ ] code\n> ```\n- [ ] plain";
  assert.deepEqual(noteTaskCounts(quoted), { done: 0, total: 2 });
});

const apply = (text, edit) => text.slice(0, edit.from) + edit.insert + text.slice(edit.to);

test("the todo button toggles the caret's line or every selected line", () => {
  let edit = toggleTaskLines("title\nbuy milk", 8, 8);
  assert.equal(apply("title\nbuy milk", edit), "title\n- [ ] buy milk");
  assert.equal(edit.selectionStart, 14);
  edit = toggleTaskLines("  - [x] done", 12, 12);
  assert.equal(apply("  - [x] done", edit), "  done");
  assert.equal(apply("- a\n\nb\n", toggleTaskLines("- a\n\nb\n", 0, 7)), "- [ ] a\n\n- [ ] b\n");
  assert.equal(apply("- [ ] a\n- [x] b", toggleTaskLines("- [ ] a\n- [x] b", 0, 15)), "a\nb");
  assert.equal(apply("", toggleTaskLines("", 0, 0)), "- [ ] ");
});

test("Enter continues a todo list and an empty item ends it", () => {
  const text = "t\n  - [x] one";
  const edit = continueTaskOnEnter(text, text.length);
  assert.equal(apply(text, edit), "t\n  - [x] one\n  - [ ] ");
  assert.equal(edit.selectionStart, apply(text, edit).length);
  const empty = "a\n- [ ] ";
  assert.equal(apply(empty, continueTaskOnEnter(empty, empty.length)), "a\n");
  assert.equal(continueTaskOnEnter("plain line", 10), null);
  assert.equal(continueTaskOnEnter("- [ ] x", 2), null);
});

test("notes group by tag, untagged last, newest first inside", () => {
  const groups = groupNotesByTag([
    { id: 1, tag: null, updatedAt: 1 }, { id: 2, tag: "b", updatedAt: 2 },
    { id: 3, tag: "a", updatedAt: 3 }, { id: 4, tag: "b", updatedAt: 4 },
  ]);
  assert.deepEqual(groups.map((group) => [group.tag, group.notes.map((note) => note.id)]), [["a", [3]], ["b", [4, 2]], [null, [1]]]);
  assert.deepEqual(groupNotesByTag([]), []);
});
