"use client";

import { useEffect, useSyncExternalStore } from "react";
import type { Note, NoteKind } from "@/lib/notes-store";

export type { Note, NoteKind };

// One copy per page, shared by the Notes view and every composer's + menu (docs/notes.md).
let notes: Note[] | null = null;
const listeners = new Set<() => void>();
/**
 * Unsaved local text and the server version it was based on, kept across editor unmounts: a
 * reopened editor resumes from both, so its next save still conflicts if another client saved.
 */
const drafts = new Map<string, { base: Note; text: string }>();
/** Counts local writes: a list fetched across one may predate it and is fetched again. */
let mutations = 0;

function publish(next: Note[]) {
  notes = next;
  listeners.forEach((listener) => listener());
}

function upsert(note: Note) {
  mutations++;
  publish([note, ...(notes ?? []).filter((item) => item.id !== note.id)]);
}

let inflight: Promise<void> | null = null;
export function refreshNotes(): Promise<void> {
  inflight ??= (async () => {
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        const seen = mutations;
        const response = await fetch("/api/notes", { cache: "no-store" });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json() as { notes: Note[] };
        if (seen !== mutations) continue;
        // Server snapshots as they are: unsaved text stays in `drafts` (shown with displayText).
        publish(data.notes);
        return;
      }
    } catch {
      if (!notes) publish([]);
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

async function request(url: string, init: RequestInit): Promise<Response> {
  return fetch(url, { ...init, headers: { "Content-Type": "application/json" } });
}

export async function createNote(text: string, kind: NoteKind, tag: string | null, keepalive = false): Promise<Note> {
  const response = await request("/api/notes", { method: "POST", body: JSON.stringify({ text, kind, tag }), keepalive });
  if (!response.ok) throw new Error(((await response.json().catch(() => null)) as { error?: string } | null)?.error ?? `HTTP ${response.status}`);
  const { note } = await response.json() as { note: Note };
  upsert(note);
  return note;
}

/**
 * `conflict`: another client saved first; `note` is the server's version, nothing was written.
 * `gone`: the note was deleted elsewhere.
 */
export async function saveNoteText(note: Note, text: string, keepalive = false): Promise<{ note: Note; conflict: boolean } | { gone: true }> {
  const response = await fetch(`/api/notes/${encodeURIComponent(note.id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, baseUpdatedAt: note.updatedAt }),
    keepalive,
  });
  const data = await response.json().catch(() => null) as { note?: Note; error?: string } | null;
  if (response.status === 409 && data?.note) return { note: data.note, conflict: true };
  if (response.status === 404) {
    mutations++;
    publish((notes ?? []).filter((item) => item.id !== note.id));
    return { gone: true };
  }
  if (!response.ok || !data?.note) throw new Error(data?.error ?? `HTTP ${response.status}`);
  upsert(data.note);
  return { note: data.note, conflict: false };
}

/** Kind and tag: they never conflict with a text edit, so no base version is sent. */
export async function setNoteMeta(id: string, meta: { kind?: NoteKind; tag?: string | null }): Promise<void> {
  const response = await request(`/api/notes/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(meta) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const { note } = await response.json() as { note: Note };
  mutations++;
  publish((notes ?? []).map((item) => item.id === id ? { ...item, kind: note.kind, tag: note.tag } : item));
}

export async function renameTag(from: string, to: string): Promise<void> {
  const response = await request("/api/notes/tags", { method: "PATCH", body: JSON.stringify({ from, to }) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  mutations++;
  await refreshNotes();
}

/**
 * With `baseUpdatedAt`, a note saved elsewhere since is kept and returned (nothing deleted);
 * otherwise null.
 */
export async function deleteNote(id: string, baseUpdatedAt?: number): Promise<Note | null> {
  const query = baseUpdatedAt === undefined ? "" : `?baseUpdatedAt=${baseUpdatedAt}`;
  const response = await fetch(`/api/notes/${encodeURIComponent(id)}${query}`, { method: "DELETE" });
  if (response.status === 409) {
    const data = await response.json().catch(() => null) as { note?: Note } | null;
    if (data?.note) return data.note;
  }
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  drafts.delete(id);
  mutations++;
  publish((notes ?? []).filter((item) => item.id !== id));
  return null;
}

/** The server's version, taken as is (a conflict resolved by loading it). */
export function adoptNote(note: Note) {
  drafts.delete(note.id);
  upsert(note);
}

/** Records unsaved text on top of `base`; text equal to the base clears it. */
export function setNoteDraft(base: Note, text: string) {
  if (text === base.text) drafts.delete(base.id);
  else drafts.set(base.id, { base, text });
}

export function getNoteDraft(id: string): { base: Note; text: string } | undefined {
  return drafts.get(id);
}

/**
 * Unsaved drafts whose note is gone from `list` (deleted elsewhere, its replacement not yet
 * saved), as notes, so they stay listed and can be reopened until saved.
 */
export function orphanDrafts(list: readonly Note[]): Note[] {
  const ids = new Set(list.map((note) => note.id));
  return [...drafts.values()].filter((draft) => !ids.has(draft.base.id)).map((draft) => draft.base);
}

/** What a list shows for a note: its unsaved text, if any. */
export function noteDisplayText(note: Note): string {
  return drafts.get(note.id)?.text ?? note.text;
}

/**
 * After `sentText` was saved over `previousBase` as `saved`: a draft of exactly that text is done;
 * a newer draft built on the same base (typed meanwhile, maybe in a reopened editor) moves onto
 * `saved`. Any other draft is left alone.
 */
export function settleNoteDraft(previousBase: Note, saved: Note, sentText: string) {
  const draft = drafts.get(saved.id);
  if (!draft) return;
  if (draft.text === sentText) drafts.delete(saved.id);
  else if (draft.base.updatedAt === previousBase.updatedAt) drafts.set(saved.id, { base: saved, text: draft.text });
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** All notes (null until the first load). Loads once per page and again when the page comes back. */
export function useNotes(): Note[] | null {
  const value = useSyncExternalStore(subscribe, () => notes, () => null);
  useEffect(() => {
    if (notes === null) void refreshNotes();
    const onVisible = () => { if (document.visibilityState === "visible") void refreshNotes(); };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onVisible);
    };
  }, []);
  return value;
}
