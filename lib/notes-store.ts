import { mkdirSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import lockfile from "proper-lockfile";
import { writePrivateFileAtomicSync } from "./atomic-file";

/** A scratch note shared by every client of this server (docs/notes.md). The first line is its title. */
export interface Note {
  id: string;
  text: string;
  /** A quick note, or a snippet (offered by the composer's + menu). */
  kind: NoteKind;
  /** At most one; notes list grouped by it. Tags exist only while a note uses them. */
  tag: string | null;
  createdAt: number;
  /** Changes only with the text; a client's edit carries the value it started from. */
  updatedAt: number;
}

interface NotesFile { version: 1; notes: Note[] }

export type NoteKind = "note" | "phrase";

export const NOTE_MAX_BYTES = 64 * 1024;
export const TAG_MAX_LENGTH = 24;
/** A request body: the note as JSON, escapes included (control characters take six bytes). */
export const NOTE_REQUEST_MAX_BYTES = NOTE_MAX_BYTES * 6 + 4096;
export const NOTES_MAX_COUNT = 1000;

export class NoteError extends Error {
  constructor(message: string, readonly status: number, readonly note?: Note) { super(message); }
}

export function getNotesPath(agentDir = getAgentDir()): string {
  return join(agentDir, "pi-web", "notes.json");
}

const isNote = (value: unknown): value is Note => {
  const note = value as Note;
  return note !== null && typeof note === "object" && typeof note.id === "string" && typeof note.text === "string"
    && (note.kind === "note" || note.kind === "phrase") && (note.tag === null || typeof note.tag === "string")
    && Number.isFinite(note.createdAt) && Number.isFinite(note.updatedAt);
};

function load(path: string): NotesFile {
  let text: string;
  try { text = readFileSync(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, notes: [] };
    throw error;
  }
  let value: NotesFile | undefined;
  try { value = JSON.parse(text); } catch { /* reported below */ }
  if (value?.version === 1 && Array.isArray(value.notes) && value.notes.every(isNote)) return value;
  throw new Error(`Corrupt notes file: ${path}; refusing to overwrite`);
}

function checkText(text: unknown): string {
  if (typeof text !== "string") throw new NoteError("text must be a string", 400);
  if (Buffer.byteLength(text) > NOTE_MAX_BYTES) throw new NoteError("Note is too long", 413);
  return text;
}

function checkKind(kind: unknown): NoteKind {
  if (kind !== "note" && kind !== "phrase") throw new NoteError("kind must be note or phrase", 400);
  return kind;
}

/** Trimmed, inner whitespace collapsed; empty means no tag. */
export function normalizeTag(tag: unknown): string | null {
  if (tag === null || tag === undefined) return null;
  if (typeof tag !== "string") throw new NoteError("tag must be a string", 400);
  const value = tag.trim().replace(/\s+/g, " ");
  if ([...value].length > TAG_MAX_LENGTH) throw new NoteError("Tag is too long", 400);
  return value || null;
}

export function listNotes(path = getNotesPath()): Note[] {
  return load(path).notes;
}

async function mutate<T>(path: string, change: (file: NotesFile) => T): Promise<T> {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  let compromised: Error | undefined;
  const release = await lockfile.lock(path, {
    realpath: false,
    retries: { retries: 10, factor: 2, minTimeout: 25, maxTimeout: 500 },
    onCompromised: (error) => { compromised = error; },
  });
  try {
    const file = load(path);
    const result = change(file);
    if (compromised) throw compromised;
    writePrivateFileAtomicSync(path, JSON.stringify(file, null, 2) + "\n", 0o600, { followSymlinks: true });
    return result;
  } finally {
    await release();
  }
}

export async function createNote(input: { text?: unknown; kind?: unknown; tag?: unknown } | null, path = getNotesPath()): Promise<Note> {
  input ??= {};
  const text = checkText(input.text);
  if (!text.trim()) throw new NoteError("Note is empty", 400);
  const kind = checkKind(input.kind ?? "note");
  const tag = normalizeTag(input.tag);
  return mutate(path, (file) => {
    if (file.notes.length >= NOTES_MAX_COUNT) throw new NoteError("Too many notes", 409);
    const now = Date.now();
    const note: Note = { id: randomUUID(), text, kind, tag, createdAt: now, updatedAt: now };
    file.notes.push(note);
    return note;
  });
}

/**
 * A text change must name the `updatedAt` it was based on; if another client saved since, the
 * write is refused with the current note (409) instead of overwriting it.
 */
export async function updateNote(id: string, input: { text?: unknown; kind?: unknown; tag?: unknown; baseUpdatedAt?: unknown } | null, path = getNotesPath()): Promise<Note> {
  if (!input || typeof input !== "object" || Array.isArray(input)
    || (input.text === undefined && input.kind === undefined && input.tag === undefined)) {
    throw new NoteError("Expected text, kind or tag", 400);
  }
  const text = input.text === undefined ? undefined : checkText(input.text);
  const kind = input.kind === undefined ? undefined : checkKind(input.kind);
  const tag = input.tag === undefined ? undefined : normalizeTag(input.tag);
  if (text !== undefined && !Number.isFinite(input.baseUpdatedAt)) throw new NoteError("baseUpdatedAt is required", 400);
  return mutate(path, (file) => {
    const note = file.notes.find((item) => item.id === id);
    if (!note) throw new NoteError("Note not found", 404);
    if (text !== undefined && text !== note.text) {
      if (input?.baseUpdatedAt !== note.updatedAt) throw new NoteError("Note changed elsewhere", 409, { ...note });
      note.text = text;
      // Strictly increasing, so two saves in one millisecond still conflict.
      note.updatedAt = Math.max(Date.now(), note.updatedAt + 1);
    }
    // Kind and tag never move updatedAt, so they never conflict with an edit elsewhere.
    if (kind !== undefined) note.kind = kind;
    if (tag !== undefined) note.tag = tag;
    return { ...note };
  });
}

/** Renames a tag on every note; renaming onto an existing tag merges the two. */
export async function renameTag(from: unknown, to: unknown, path = getNotesPath()): Promise<void> {
  const source = normalizeTag(from);
  const target = normalizeTag(to);
  if (!source || !target) throw new NoteError("from and to are required", 400);
  await mutate(path, (file) => {
    for (const note of file.notes) if (note.tag === source) note.tag = target;
  });
}

/** With `baseUpdatedAt`, a note saved elsewhere since is kept (409 with the current note). */
export function deleteNote(id: string, path = getNotesPath(), baseUpdatedAt?: number): Promise<void> {
  return mutate(path, (file) => {
    const index = file.notes.findIndex((note) => note.id === id);
    if (index < 0) return;
    if (baseUpdatedAt !== undefined && file.notes[index].updatedAt !== baseUpdatedAt) {
      throw new NoteError("Note changed elsewhere", 409, { ...file.notes[index] });
    }
    file.notes.splice(index, 1);
  });
}
