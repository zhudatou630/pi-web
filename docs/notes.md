# Notes

Global quick notes and snippets shared by every client of one Pi Web server. Deliberately light: no agent access (no tool, no context, no pin), no projects, folders, search or filters.

## Data
- `~/.pi/agent/pi-web/notes.json` (`lib/notes-store.ts`, locked + atomic like the sidebar state; a corrupt file is never overwritten). `{ version: 1, notes: [{ id, text, kind, tag, createdAt, updatedAt }] }`.
- `kind` is `"note"` (quick note) or `"phrase"` (snippet). `tag` is at most one string (trimmed, inner whitespace collapsed, ≤ 24 characters) or null. One tag, not many: grouping by tag then never lists a note twice.
- Tags have no table of their own: a tag exists while a note uses it. Notes and snippets share the tag vocabulary; each list shows only the tags it uses.
- A note is plain Markdown; its first non-empty line is the title (`#` stripped). Todos are its `- [ ]` / `- [x]` lines (`lib/note-text.ts`, fenced code skipped).
- Limits: 64 KB per note (413), 1000 notes (409). Empty notes cannot be created.
- API: `GET/POST /api/notes`, `PATCH/DELETE /api/notes/[id]`, `PATCH /api/notes/tags { from, to }` (rename on every note; onto an existing tag it merges).

## Concurrency
- A text PATCH carries `baseUpdatedAt`; if another client saved since, the server answers `409 { note }` and writes nothing. The editor then offers "Load new version" / "Keep mine" (the latter re-saves on top of the server version). Never overwrite silently.
- `updatedAt` is strictly increasing and moves only with the text: kind, tag and tag renames never conflict with an edit elsewhere.
- Clients load once per page (`hooks/useNotes.ts`, one copy shared by the view and every composer) and again on `visibilitychange`→visible and `online`. No SSE or polling. The store holds server snapshots only; a GET that overlapped a local write is fetched again.
- Unsaved text lives in `drafts` (`{ base, text }` per note, page memory), shown by lists and resumed by a reopened editor with its base, so its save still conflicts. A finished save clears only the draft it sent and moves a newer draft on the same base onto the result (`settleNoteDraft`).
- The editor saves 600 ms after typing stops, on blur, on leaving (unmount) and on a hidden page (`keepalive`, best effort). Saves run one at a time. Back waits for the save and stays put on failure or conflict (the error / conflict line says why); while it runs the text is read-only.
- A new note is created by its first non-empty save; going back from an empty one leaves nothing. Emptying an existing note then going back deletes it with `?baseUpdatedAt=`, so a version saved elsewhere since is kept (409, conflict line).
- A note deleted elsewhere while this editor holds unsaved text stays open and is saved as a new note; until then its draft stays listed.
- Known limit: drafts are page memory. Unsaved text whose save keeps failing is lost on reload.

## UI
- The file panel's third fixed view, `Changes | Files | Notes`, also in `⋯`'s panel shortcuts. Unlike the other two it follows no cwd, project or session.
- List: a toolbar row with the kind switch `Notes | Snippets` (remembered per device) and a text button whose label names what it creates ("New note" / "New snippet"); no quick-entry field. Rows: title (`--text-muted`, `.fade-clip`) and time, a second line only for more text or todos (`1/3 · preview`). One trailing action: Insert for snippets, Copy for notes, then `⋯` (both on hover with fine pointers; touch keeps the first and long-presses for the menu). Right-click and long press open one menu at the pointer, `⋯` under itself (right edges aligned): Insert into message, Copy, Make snippet / Make note, Delete.
- Delete never uses a modal: the menu turns into the inline confirm the sidebar and file tree use (title, the note's title, Cancel / Delete), the same from a row and from the editor's `⋯`.
- Groups: shown only while some note in the list has a tag. Tags in name order, "Untagged" last, newest edit first inside. A head folds (remembered per device; a folded head shows its count). A tag head's `⋯` holds Rename tag (inline field; onto an existing tag asks before merging).
- Todos stay plain Markdown in a plain textarea (no rich editor). The editor's checklist button turns the caret's line, or every selected line, into `- [ ] ` items, or back when all are items; Enter at the end of an item starts the next, Enter on an empty item ends the list (`toggleTaskLines` / `continueTaskOnEnter` in `lib/note-text.ts`, applied through the native edit so Undo works). Ticking happens in Read.
- Editor: back, the tag menu ("Add tag" or the tag: find, pick, create, No tag), time, Checklist (edit mode), Read/Edit, Insert (snippets), Copy, `⋯` (the row menu, acting on the text shown). Edit is a borderless textarea in the prose font at 13px (the panel's reading tier, as the file viewer); Read renders `MarkdownBody` with clickable task checkboxes, saved at once: `onToggleTask` gets the list item's source offset from the renderer (raw text, no normalization), so code blocks or quotes never shift which line is written (`toggleNoteTaskAt`). No "saved" indicator; only failures show, with Retry.
- Insert goes to the focused composer (`insertText`); a panel covering the chat (phone, overlay widths) closes.
- Composer: `+` opens a menu when image generation or any snippet exists; "Snippets ›" lists titles grouped by tag (headings only when some snippet is tagged) and inserts the full text at the caret.
