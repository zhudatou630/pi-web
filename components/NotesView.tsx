"use client";

import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type TouchEvent } from "react";
import { createPortal } from "react-dom";
import { useConfirm } from "@/hooks/useConfirm";
import { useI18n } from "@/hooks/useI18n";
import { adoptNote, createNote, deleteNote, getNoteDraft, noteDisplayText, orphanDrafts, renameTag, saveNoteText, setNoteDraft, setNoteMeta, settleNoteDraft, useNotes, type Note, type NoteKind } from "@/hooks/useNotes";
import { copyText } from "@/lib/clipboard";
import { formatCompactRelativeTime } from "@/lib/i18n/format";
import { isImeComposing } from "@/lib/ime";
import { continueTaskOnEnter, groupNotesByTag, notePreview, noteTaskCounts, noteTitle, toggleNoteTaskAt, toggleTaskLines, type NoteTextEdit } from "@/lib/note-text";
import { replaceTextareaRange } from "./ChatInput";
import { CopyGlyph } from "./CopyGlyph";
import { MarkdownBody } from "./MarkdownBody";
import { isModalDialogOpen } from "./ModalDialog";
import { MenuCheck } from "./MenuCheck";
import { IconButton, TextMenu } from "./PanelViews";

const SAVE_DELAY_MS = 600;
type SaveOutcome = "ok" | "failed" | "conflict";
const KIND_KEY = "pi-web:notes-kind";
const COLLAPSED_KEY = "pi-web:notes-collapsed";
const KINDS: readonly NoteKind[] = ["note", "phrase"];

function readStored<T>(key: string, fallback: T): T {
  try { return JSON.parse(window.localStorage.getItem(key) ?? "null") ?? fallback; } catch { return fallback; }
}

/** The file panel's Notes view: global quick notes and snippets, grouped by tag (docs/notes.md). */
export function NotesView({ onInsert }: { onInsert: (text: string) => void }) {
  const notes = useNotes();
  const [kind, setKind] = useState<NoteKind>(() => readStored<string>(KIND_KEY, "note") === "phrase" ? "phrase" : "note");
  // `key` keeps one editor instance while a new note gets its id.
  const [open, setOpen] = useState<{ key: number; id: string | null; kind: NoteKind } | null>(null);
  const selectKind = useCallback((next: NoteKind) => {
    setKind(next);
    window.localStorage.setItem(KIND_KEY, JSON.stringify(next));
  }, []);
  const tags = [...new Set((notes ?? []).flatMap((note) => note.tag ? [note.tag] : []))].sort((a, b) => a.localeCompare(b));
  // A note deleted on another device keeps its editor while it holds unsaved text (saved as new).
  const note = open?.id ? notes?.find((item) => item.id === open.id) ?? getNoteDraft(open.id)?.base : undefined;

  if (open && !(open.id && notes && !note)) {
    return (
      <NoteEditor
        key={open.key}
        note={note}
        kind={note?.kind ?? open.kind}
        tags={tags}
        onCreated={(id) => setOpen((current) => current && { ...current, id })}
        onBack={(shown) => { setOpen(null); selectKind(shown); }}
        onInsert={onInsert}
      />
    );
  }
  return (
    <NoteList
      notes={notes}
      kind={kind}
      tags={tags}
      onKind={selectKind}
      onOpen={(id) => setOpen({ key: Date.now(), id, kind })}
      onNew={() => setOpen({ key: Date.now(), id: null, kind })}
      onInsert={onInsert}
    />
  );
}

function useCopied() {
  const [copied, setCopied] = useState<string | null>(null);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(null), 1200);
    return () => window.clearTimeout(timer);
  }, [copied]);
  return [copied, (id: string, text: string) => { void copyText(text).then(() => setCopied(id)); }] as const;
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={open ? "M2 3.5 5 6.5 8 3.5" : "M3.5 2 6.5 5 3.5 8"} />
    </svg>
  );
}

interface MenuTarget { note: Note; x: number; y: number; anchor?: HTMLElement }

/**
 * A note's actions (row right-click / long press / ⋯, the editor's ⋯). Delete turns the menu into
 * the same inline confirm as deleting a session or a file.
 */
function NoteMenu({ target, onClose, onInsert, onDeleted }: { target: MenuTarget; onClose: () => void; onInsert: (text: string) => void; onDeleted?: () => void }) {
  const { t } = useI18n();
  const ref = useRef<HTMLDivElement>(null);
  const [confirming, setConfirming] = useState(false);
  const { note, anchor } = target;
  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const node = event.target as Node;
      if (!ref.current?.contains(node) && !anchor?.contains(node)) onClose();
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || isImeComposing(event) || isModalDialogOpen()) return;
      event.preventDefault();
      onClose();
      anchor?.focus();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [anchor, onClose]);
  const item = (action: () => void) => () => { onClose(); action(); };
  return createPortal(
    <div
      key={confirming ? "confirm" : "menu"}
      ref={ref}
      role={confirming ? undefined : "menu"}
      className="project-context-menu menu-surface"
      // From ⋯ the menu hangs under the button, right edges aligned; from a pointer, at the pointer.
      style={anchor
        ? { left: "auto", right: Math.max(4, window.innerWidth - anchor.getBoundingClientRect().right), top: Math.max(4, Math.min(target.y + 2, window.innerHeight - 156)) }
        : { left: Math.max(4, Math.min(target.x + 2, window.innerWidth - 254)), top: Math.max(4, Math.min(target.y + 2, window.innerHeight - 156)) }}
    >
      {confirming ? (
        <div role="alertdialog" aria-labelledby="delete-note-title" aria-describedby="delete-note-detail" className="project-confirm">
          <div id="delete-note-title">{t(note.kind === "phrase" ? "notes.deletePhraseConfirm" : "notes.deleteNoteConfirm")}</div>
          <div id="delete-note-detail">{noteTitle(note.text) || t("notes.untitled")}</div>
          <div className="project-confirm-actions">
            <button type="button" autoFocus onClick={onClose}>{t("i18n.cancel")}</button>
            <button type="button" className="is-danger" onClick={item(() => { void deleteNote(note.id).then(() => onDeleted?.(), () => undefined); })}>{t("notes.delete")}</button>
          </div>
        </div>
      ) : (
        <>
          <button type="button" role="menuitem" onClick={item(() => onInsert(note.text))}>{t("notes.insert")}</button>
          <button type="button" role="menuitem" onClick={item(() => void copyText(note.text))}>{t("notes.copy")}</button>
          <button type="button" role="menuitem" onClick={item(() => void setNoteMeta(note.id, { kind: note.kind === "phrase" ? "note" : "phrase" }).catch(() => undefined))}>
            {t(note.kind === "phrase" ? "notes.toNote" : "notes.toPhrase")}
          </button>
          <div role="separator" className="menu-surface-divider" />
          <button type="button" role="menuitem" className="is-danger" onClick={() => setConfirming(true)}>{t("notes.delete")}</button>
        </>
      )}
    </div>,
    document.body,
  );
}

/** Long press opens the menu on touch (iOS fires no contextmenu); same 400ms/10px as file rows. */
function useLongPress(onPress: (x: number, y: number) => void) {
  const pressRef = useRef<{ timer: ReturnType<typeof setTimeout>; x: number; y: number } | null>(null);
  const firedRef = useRef(false);
  const cancel = () => {
    if (pressRef.current) clearTimeout(pressRef.current.timer);
    pressRef.current = null;
  };
  return {
    /** True once after a long press, so the click that ends it opens nothing. */
    consumed: () => { const fired = firedRef.current; firedRef.current = false; return fired; },
    handlers: {
      onTouchStart: (event: TouchEvent) => {
        const { clientX: x, clientY: y } = event.touches[0];
        firedRef.current = false;
        cancel();
        pressRef.current = { x, y, timer: setTimeout(() => { firedRef.current = true; pressRef.current = null; onPress(x, y); navigator.vibrate?.(15); }, 400) };
      },
      onTouchMove: (event: TouchEvent) => {
        const start = pressRef.current;
        const touch = event.touches[0];
        if (start && (Math.abs(touch.clientX - start.x) > 10 || Math.abs(touch.clientY - start.y) > 10)) cancel();
      },
      onTouchEnd: cancel,
      onTouchCancel: cancel,
    },
  };
}

function NoteRow({ note, menuOpen, copied, onOpen, onInsert, onCopy, onMenu }: {
  note: Note;
  menuOpen: boolean;
  copied: boolean;
  onOpen: () => void;
  onInsert: () => void;
  onCopy: () => void;
  onMenu: (x: number, y: number, anchor?: HTMLElement) => void;
}) {
  const { t, locale } = useI18n();
  const press = useLongPress((x, y) => onMenu(x, y));
  // Unsaved text left by a closed editor shows here too.
  const text = noteDisplayText(note);
  const preview = notePreview(text);
  const tasks = noteTaskCounts(text);
  return (
    <div className="notes-row" data-menu-open={menuOpen || undefined} onContextMenu={(event) => { event.preventDefault(); onMenu(event.clientX, event.clientY); }} {...press.handlers}>
      <button type="button" className="notes-row-main" onClick={() => { if (!press.consumed()) onOpen(); }}>
        <span className="notes-row-line">
          <span className="notes-row-title fade-clip">{noteTitle(text) || t("notes.untitled")}</span>
          <span className="notes-row-time">{formatCompactRelativeTime(new Date(note.updatedAt), locale)}</span>
        </span>
        {(preview || tasks.total > 0) && (
          <span className="notes-row-preview">{tasks.total > 0 ? `${tasks.done}/${tasks.total}${preview ? " · " : ""}` : ""}{preview}</span>
        )}
      </button>
      {note.kind === "phrase" ? (
        <IconButton title={t("notes.insert")} onClick={onInsert}>
          <path d="M9 10 4 15l5 5" /><path d="M20 4v7a4 4 0 0 1-4 4H4" />
        </IconButton>
      ) : (
        <IconButton title={t("notes.copy")} onClick={onCopy}>
          {copied ? <polyline points="20 6 9 17 4 12" /> : <CopyGlyph />}
        </IconButton>
      )}
      <span className="notes-row-more">
        <MoreButton title={t("notes.more")} expanded={menuOpen} onOpen={onMenu} />
      </span>
    </div>
  );
}

/** ⋯ that opens a NoteMenu under itself; a second click closes it. */
function MoreButton({ title, expanded, onOpen }: { title: string; expanded: boolean; onOpen: (x: number, y: number, anchor?: HTMLElement) => void }) {
  return (
    <button type="button" className="ghost-icon-button" title={title} aria-label={title} aria-haspopup="menu" aria-expanded={expanded} onClick={(event) => {
      const rect = event.currentTarget.getBoundingClientRect();
      onOpen(rect.right, rect.bottom, event.currentTarget);
    }}>
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
        <circle cx="5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" />
      </svg>
    </button>
  );
}

function NoteList({ notes, kind, tags, onKind, onOpen, onNew, onInsert }: {
  notes: Note[] | null;
  kind: NoteKind;
  tags: string[];
  onKind: (kind: NoteKind) => void;
  onOpen: (id: string) => void;
  onNew: () => void;
  onInsert: (text: string) => void;
}) {
  const { t } = useI18n();
  const confirm = useConfirm();
  const [copied, copy] = useCopied();
  const [menu, setMenu] = useState<MenuTarget | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const [collapsed, setCollapsed] = useState<string[]>(() => readStored(COLLAPSED_KEY, []));
  const [renaming, setRenaming] = useState<{ from: string; value: string } | null>(null);
  const [failed, setFailed] = useState(false);

  const listed = notes ? [...notes, ...orphanDrafts(notes)] : [];
  const groups = groupNotesByTag(listed.filter((note) => note.kind === kind));
  const headed = groups.some((group) => group.tag !== null);
  const toggleGroup = (key: string) => {
    const next = collapsed.includes(key) ? collapsed.filter((item) => item !== key) : [...collapsed, key];
    setCollapsed(next);
    window.localStorage.setItem(COLLAPSED_KEY, JSON.stringify(next));
  };
  const commitRename = async () => {
    if (!renaming) return;
    const { from } = renaming;
    const to = renaming.value.trim().replace(/\s+/g, " ");
    setRenaming(null);
    if (!to || to === from) return;
    if (tags.includes(to) && !await confirm(t("notes.mergeTagConfirm", { from, to }))) return;
    renameTag(from, to).catch(() => setFailed(true));
  };
  const onRenameKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Enter") { event.preventDefault(); void commitRename(); }
    if (event.key === "Escape") { event.preventDefault(); setRenaming(null); }
  };

  let body;
  if (!notes) body = <div className="panel-view-empty">{t("notes.loading")}</div>;
  else if (groups.length === 0) body = <div className="panel-view-empty">{t(kind === "phrase" ? "notes.emptyPhrases" : "notes.emptyNotes")}</div>;
  else body = groups.map((group) => {
    const key = `${kind}:${group.tag ?? ""}`;
    const isOpen = !headed || !collapsed.includes(key);
    return (
      <div key={key}>
        {headed && (
          <div className="notes-group">
            {renaming && renaming.from === group.tag ? (
              <input
                className="notes-group-rename"
                value={renaming.value}
                maxLength={24}
                autoFocus
                aria-label={t("notes.renameTag")}
                onChange={(event) => setRenaming({ ...renaming, value: event.target.value })}
                onKeyDown={onRenameKey}
                onBlur={() => void commitRename()}
              />
            ) : (
              <button type="button" className="notes-group-toggle" aria-expanded={isOpen} onClick={() => toggleGroup(key)}>
                <Chevron open={isOpen} />
                <span className="notes-group-name">{group.tag ?? t("notes.untagged")}</span>
                {!isOpen && <span className="notes-group-count">{group.notes.length}</span>}
              </button>
            )}
            {group.tag !== null && !renaming && (
              <TextMenu className="notes-more-menu notes-group-menu" icon={(menuOpen, toggle) => (
                <IconButton title={t("notes.tagActions")} expanded={menuOpen} onClick={toggle}>
                  <circle cx="5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" />
                </IconButton>
              )}>
                {(close) => (
                  <button type="button" role="menuitem" onClick={() => { close(); setRenaming({ from: group.tag!, value: group.tag! }); }}>{t("notes.renameTag")}</button>
                )}
              </TextMenu>
            )}
          </div>
        )}
        {isOpen && group.notes.map((note) => (
          <NoteRow
            key={note.id}
            note={note}
            menuOpen={menu?.note.id === note.id}
            copied={copied === note.id}
            onOpen={() => onOpen(note.id)}
            onInsert={() => onInsert(noteDisplayText(note))}
            onCopy={() => copy(note.id, noteDisplayText(note))}
            onMenu={(x, y, anchor) => setMenu((current) => current && anchor && current.anchor === anchor ? null : { note: { ...note, text: noteDisplayText(note) }, x, y, anchor })}
          />
        ))}
      </div>
    );
  });

  return (
    <div className="panel-view">
      <div className="notes-toolbar">
        <div role="tablist" aria-label={t("panel.notes")} className="notes-kinds">
          {KINDS.map((item) => (
            <button key={item} type="button" role="tab" aria-selected={kind === item} className="panel-view-tab" onClick={() => onKind(item)}>
              {t(item === "phrase" ? "notes.phrases" : "notes.notes")}
            </button>
          ))}
        </div>
        <span className="file-toolbar-spacer" />
        <button type="button" className="panel-text-menu-trigger notes-new" onClick={onNew}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
          {t(kind === "phrase" ? "notes.newPhrase" : "notes.newNote")}
        </button>
      </div>
      {failed && <div role="alert" className="panel-view-empty is-error">{t("notes.saveFailed")}</div>}
      <div className="panel-view-scroll scroll-fade-block">{body}</div>
      {menu && <NoteMenu target={menu} onClose={closeMenu} onInsert={onInsert} />}
    </div>
  );
}

/** Pick, create or clear the note's one tag; tags are shared by notes and snippets. */
function TagMenu({ value, tags, onChange, close }: { value: string | null; tags: string[]; onChange: (tag: string | null) => void; close: () => void }) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const typed = query.trim().replace(/\s+/g, " ");
  const shown = tags.filter((tag) => tag.toLowerCase().includes(typed.toLowerCase()));
  const pick = (tag: string | null) => { close(); if (tag !== value) onChange(tag); };
  return (
    <>
      <input
        className="notes-tag-search"
        value={query}
        maxLength={24}
        autoFocus
        placeholder={t("notes.tagSearch")}
        aria-label={t("notes.tagSearch")}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || event.nativeEvent.isComposing || !typed) return;
          event.preventDefault();
          pick(tags.find((tag) => tag === typed) ?? shown[0] ?? typed);
        }}
      />
      {shown.map((tag) => (
        <button key={tag} type="button" role="menuitemradio" aria-checked={tag === value} onClick={() => pick(tag)}>
          <span className="panel-text-menu-label">{tag}</span>
          <MenuCheck checked={tag === value} />
        </button>
      ))}
      {typed && !tags.includes(typed) && (
        <button type="button" role="menuitem" onClick={() => pick(typed)}>{t("notes.createTag", { name: typed })}</button>
      )}
      {value && (
        <>
          <div role="separator" className="menu-surface-divider" />
          <button type="button" role="menuitem" onClick={() => pick(null)}>{t("notes.noTag")}</button>
        </>
      )}
    </>
  );
}

function NoteEditor({ note, kind, tags, onCreated, onBack, onInsert }: {
  /** Absent for a new note: it is created with its first text. */
  note: Note | undefined;
  kind: NoteKind;
  tags: string[];
  onCreated: (id: string) => void;
  onBack: (kind: NoteKind) => void;
  onInsert: (text: string) => void;
}) {
  const { t, locale } = useI18n();
  const [menu, setMenu] = useState<MenuTarget | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  // A reopened note resumes its unsaved text and the version that text was based on.
  const [initial] = useState(() => {
    const resumed = note ? getNoteDraft(note.id) : undefined;
    return { text: resumed?.text ?? note?.text ?? "", base: resumed?.base ?? note ?? null };
  });
  const [draft, setDraft] = useState(initial.text);
  const [draftTag, setDraftTag] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const [conflict, setConflict] = useState<Note | null>(null);
  // The error line: what failed and its Retry. A later save clears only a save's error.
  const [failed, setFailed] = useState<{ kind: "save" | "tag"; retry: () => void } | null>(null);
  // Back in progress: the text is read-only, so nothing typed now is lost when the editor closes.
  const [closing, setClosing] = useState(false);
  const [copied, copy] = useCopied();
  // The server version the draft was based on; saves run one at a time so each carries the last one.
  const baseRef = useRef<Note | null>(initial.base);
  const draftRef = useRef(draft);
  const draftTagRef = useRef<string | null>(null);
  const conflictRef = useRef<Note | null>(null);
  const discardedRef = useRef(false);
  const chainRef = useRef<Promise<SaveOutcome>>(Promise.resolve("ok"));
  const timerRef = useRef<number | undefined>(undefined);
  const kindRef = useRef(kind);
  kindRef.current = kind;
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // Through the native edit path, so Undo takes it back; the input event saves it.
  const applyEdit = (edit: NoteTextEdit) => {
    const input = inputRef.current;
    if (!input) return;
    replaceTextareaRange(input, edit.from, edit.to, edit.insert);
    input.setSelectionRange(edit.selectionStart, edit.selectionEnd);
  };
  const onCreatedRef = useRef(onCreated);
  onCreatedRef.current = onCreated;
  const tag = note ? note.tag : draftTag;
  const tagRef = useRef(tag);
  tagRef.current = tag;

  const applyTag = useCallback((id: string, value: string | null) => {
    setNoteMeta(id, { tag: value }).then(
      () => setFailed((current) => current?.kind === "tag" ? null : current),
      () => setFailed({ kind: "tag", retry: () => applyTag(id, value) }),
    );
  }, []);

  const save = useCallback((keepalive = false): Promise<SaveOutcome> => {
    window.clearTimeout(timerRef.current);
    chainRef.current = chainRef.current.then(async (): Promise<SaveOutcome> => {
      const text = draftRef.current;
      // Another editor of this note (closed, its save still landing) may have moved the shared draft on.
      const shared = baseRef.current && getNoteDraft(baseRef.current.id);
      if (shared && baseRef.current && shared.base.updatedAt > baseRef.current.updatedAt) baseRef.current = shared.base;
      const base = baseRef.current;
      if (discardedRef.current) return "ok";
      if (conflictRef.current) return "conflict";
      try {
        if (!base) {
          if (!text.trim()) return "ok";
          const created = await createNote(text, kindRef.current, draftTagRef.current, keepalive);
          baseRef.current = created;
          onCreatedRef.current(created.id);
          if (draftRef.current !== text) setNoteDraft(created, draftRef.current);
          // A tag picked while the note was being created.
          if (draftTagRef.current !== created.tag) applyTag(created.id, draftTagRef.current);
        } else if (text !== base.text) {
          const result = await saveNoteText(base, text, keepalive);
          if ("gone" in result) {
            // Deleted on another device while this text was unsaved: keep it as a new note. The old
            // draft stays (and keeps this editor open) until the new note exists.
            const created = await createNote(text, kindRef.current, tagRef.current, keepalive);
            setNoteDraft(base, base.text);
            baseRef.current = created;
            onCreatedRef.current(created.id);
            if (draftRef.current !== text) setNoteDraft(created, draftRef.current);
          } else if (result.conflict) {
            conflictRef.current = result.note;
            setConflict(result.note);
            return "conflict";
          } else {
            baseRef.current = result.note;
            settleNoteDraft(base, result.note, text);
          }
        }
        setFailed((current) => current?.kind === "save" ? null : current);
        return "ok";
      } catch {
        setFailed({ kind: "save", retry: () => void save() });
        return "failed";
      }
    });
    return chainRef.current;
  }, [applyTag]);

  const change = (text: string, now = false) => {
    draftRef.current = text;
    setDraft(text);
    if (baseRef.current) setNoteDraft(baseRef.current, text);
    window.clearTimeout(timerRef.current);
    if (now) void save();
    else timerRef.current = window.setTimeout(() => void save(), SAVE_DELAY_MS);
  };

  // Leaving (another view, closing the panel, a hidden page) saves at once; keepalive outlives the page.
  useEffect(() => {
    const flush = () => { if (document.visibilityState === "hidden") void save(true); };
    const onPageHide = () => void save(true);
    document.addEventListener("visibilitychange", flush);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      document.removeEventListener("visibilitychange", flush);
      window.removeEventListener("pagehide", onPageHide);
      void save(true);
    };
  }, [save]);

  // Another device saved while this one shows the note unchanged: show theirs.
  useEffect(() => {
    const base = baseRef.current;
    if (!note || !base || note.id !== base.id || note.updatedAt <= base.updatedAt) return;
    if (draftRef.current !== base.text || conflictRef.current) return;
    baseRef.current = note;
    draftRef.current = note.text;
    setDraft(note.text);
  }, [note]);

  // Back stays put while the text is not safely stored: the error or conflict line says why.
  const back = async () => {
    setClosing(true);
    if (await save() !== "ok") { setClosing(false); return; }
    const base = baseRef.current;
    if (base && !draftRef.current.trim()) {
      try {
        const kept = await deleteNote(base.id, base.updatedAt);
        if (kept) { conflictRef.current = kept; setConflict(kept); setClosing(false); return; }
        discardedRef.current = true;
      } catch {
        setFailed({ kind: "save", retry: () => void back() });
        setClosing(false);
        return;
      }
    }
    onBack(kindRef.current);
  };
  const resolve = (keepMine: boolean) => {
    const server = conflictRef.current;
    if (!server) return;
    conflictRef.current = null;
    setConflict(null);
    baseRef.current = server;
    if (keepMine) { setNoteDraft(server, draftRef.current); void save(); return; }
    draftRef.current = server.text;
    setDraft(server.text);
    adoptNote(server);
  };
  const setTag = (value: string | null) => {
    if (note) { applyTag(note.id, value); return; }
    // Not created yet: the tag goes with the first save (or right after it, if that is in flight).
    draftTagRef.current = value;
    setDraftTag(value);
  };

  return (
    <div className="panel-view">
      <div className="notes-editor-head">
        <IconButton title={t("notes.back")} onClick={() => void back()}>
          <path d="m15 18-6-6 6-6" />
        </IconButton>
        <TextMenu
          className="notes-tag-menu"
          label={<span className="panel-text-menu-label">{tag ?? t("notes.addTag")}</span>}
          title={t("notes.tag")}
        >
          {(close) => <TagMenu value={tag} tags={tags} onChange={setTag} close={close} />}
        </TextMenu>
        {note && <span className="notes-editor-time">{formatCompactRelativeTime(new Date(note.updatedAt), locale)}</span>}
        <span className="file-toolbar-spacer" />
        {!reading && (
          <button
            type="button"
            className="ghost-icon-button"
            title={t("notes.checklist")}
            aria-label={t("notes.checklist")}
            // Keep the caret and selection in the text.
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => {
              const input = inputRef.current;
              if (input) applyEdit(toggleTaskLines(input.value, input.selectionStart, input.selectionEnd));
            }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="3" y="3" width="18" height="18" rx="3" /><path d="m8 12 3 3 5-6" />
            </svg>
          </button>
        )}
        <IconButton title={t(reading ? "notes.edit" : "notes.read")} pressed={reading} onClick={() => setReading((value) => !value)}>
          <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" /><circle cx="12" cy="12" r="3" />
        </IconButton>
        {kind === "phrase" && (
          <IconButton title={t("notes.insert")} disabled={!draft.trim()} onClick={() => onInsert(draft)}>
            <path d="M9 10 4 15l5 5" /><path d="M20 4v7a4 4 0 0 1-4 4H4" />
          </IconButton>
        )}
        <IconButton title={t("notes.copy")} disabled={!draft} onClick={() => copy("draft", draft)}>
          {copied ? <polyline points="20 6 9 17 4 12" /> : <CopyGlyph />}
        </IconButton>
        {note && (
          <MoreButton title={t("notes.more")} expanded={Boolean(menu)} onOpen={(x, y, anchor) => {
            // The menu acts on what is shown, unsaved text included.
            setMenu((current) => current ? null : { note: { ...note, text: draftRef.current }, x, y, anchor });
          }} />
        )}
        {menu && (
          <NoteMenu target={menu} onClose={closeMenu} onInsert={onInsert} onDeleted={() => {
            window.clearTimeout(timerRef.current);
            discardedRef.current = true;
            onBack(kindRef.current);
          }} />
        )}
      </div>
      {conflict && (
        <div role="alert" className="notes-editor-notice">
          <span>{t("notes.conflict")}</span>
          <button type="button" onClick={() => resolve(false)}>{t("notes.loadTheirs")}</button>
          <button type="button" onClick={() => resolve(true)}>{t("notes.keepMine")}</button>
        </div>
      )}
      {failed && !conflict && (
        <div role="alert" className="notes-editor-notice is-error">
          <span>{t("notes.saveFailed")}</span>
          <button type="button" onClick={failed.retry}>{t("notes.retry")}</button>
        </div>
      )}
      {reading ? (
        <div className="notes-editor-body notes-editor-read">
          <MarkdownBody onToggleTask={(offset) => { if (!closing) change(toggleNoteTaskAt(draftRef.current, offset), true); }}>{draft}</MarkdownBody>
        </div>
      ) : (
        <textarea
          ref={inputRef}
          className="notes-editor-body notes-editor-input"
          value={draft}
          readOnly={closing}
          autoFocus={!note}
          placeholder={t(kind === "phrase" ? "notes.phrasePlaceholder" : "notes.notePlaceholder")}
          aria-label={noteTitle(draft) || t("notes.untitled")}
          onChange={(event) => change(event.target.value)}
          onKeyDown={(event) => {
            const input = event.currentTarget;
            if (event.key !== "Enter" || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey || isImeComposing(event)) return;
            if (input.selectionStart !== input.selectionEnd) return;
            const edit = continueTaskOnEnter(input.value, input.selectionStart);
            if (!edit) return;
            event.preventDefault();
            applyEdit(edit);
          }}
          onBlur={() => void save()}
        />
      )}
    </div>
  );
}
