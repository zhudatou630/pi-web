import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const { createNote, updateNote, deleteNote, listNotes, renameTag, NoteError, NOTE_MAX_BYTES } = await createJiti(import.meta.url).import("./notes-store.ts");

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "pi-notes-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "pi-web", "notes.json");
}

test("notes round-trip and a stale text edit is refused with the current note", async (t) => {
  const path = fixture(t);
  assert.deepEqual(listNotes(path), []);
  const note = await createNote({ text: "idea\nmore", tag: "  release   notes " }, path);
  assert.equal(note.kind, "note");
  assert.equal(note.tag, "release notes");

  const saved = await updateNote(note.id, { text: "idea v2", baseUpdatedAt: note.updatedAt }, path);
  assert.ok(saved.updatedAt > note.updatedAt);
  await assert.rejects(updateNote(note.id, { text: "stale", baseUpdatedAt: note.updatedAt }, path),
    (error) => error instanceof NoteError && error.status === 409 && error.note.text === "idea v2");

  // Kind and tag do not move updatedAt, so they never conflict with an edit elsewhere.
  const phrase = await updateNote(note.id, { kind: "phrase", tag: "" }, path);
  assert.equal(phrase.updatedAt, saved.updatedAt);
  assert.deepEqual([listNotes(path)[0].kind, listNotes(path)[0].tag], ["phrase", null]);

  const other = await createNote({ text: "b", kind: "phrase", tag: "a" }, path);
  await createNote({ text: "c", tag: "b" }, path);
  await renameTag("a", "b", path);
  assert.deepEqual(listNotes(path).map((item) => item.tag), [null, "b", "b"]);
  await deleteNote(other.id, path);

  await deleteNote(note.id, path);
  assert.deepEqual(listNotes(path).map((item) => item.text), ["c"]);
});

test("notes reject bad input and never overwrite a corrupt file", async (t) => {
  const path = fixture(t);
  await assert.rejects(createNote({ text: "  " }, path), (error) => error.status === 400);
  await assert.rejects(createNote(null, path), (error) => error.status === 400);
  await assert.rejects(createNote({ text: "x".repeat(NOTE_MAX_BYTES + 1) }, path), (error) => error.status === 413);
  const note = await createNote({ text: "a" }, path);
  await assert.rejects(updateNote(note.id, { text: "b" }, path), (error) => error.status === 400);
  await assert.rejects(updateNote("missing", { kind: "phrase" }, path), (error) => error.status === 404);
  await assert.rejects(createNote({ text: "a", kind: "todo" }, path), (error) => error.status === 400);
  await assert.rejects(createNote({ text: "a", tag: "x".repeat(25) }, path), (error) => error.status === 400);
  await assert.rejects(renameTag("a", " ", path), (error) => error.status === 400);
  await assert.rejects(updateNote(note.id, {}, path), (error) => error.status === 400);
  await assert.rejects(updateNote(note.id, null, path), (error) => error.status === 400);
  // Deleting with a stale version keeps the note saved elsewhere.
  await assert.rejects(deleteNote(note.id, path, note.updatedAt - 1), (error) => error.status === 409 && error.note.id === note.id);
  await deleteNote(note.id, path, note.updatedAt);
  assert.equal(listNotes(path).some((item) => item.id === note.id), false);
  writeFileSync(path, "{");
  await assert.rejects(createNote({ text: "a" }, path), /Corrupt notes file/);
});
