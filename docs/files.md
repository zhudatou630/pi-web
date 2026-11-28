# File access and previews

## Uploads

Drop files or folders onto the tree root, a folder row, or chat. The Files toolbar also opens file and folder pickers. Folder uploads retain subfolders with files and skip dot-entries inside the selected folder; empty folders are not uploaded. Chat attaches loose images as before and inserts one mention per uploaded folder. The explorer highlights the uploaded top-level entries.

The files route takes multipart `files` and parallel `paths` fields for `?type=upload`; `?type=upload-check` takes JSON `{ paths }`. Paths are relative to the requested directory, and intermediate symlinks are refused. Conflicts are handled per file.

Uploads have a 100 MiB combined file limit (101 MiB wire-body limit for multipart overhead), checked in the browser before sending and on the server before any file is written; there is no separate per-file cap. Writes are asynchronous. Replacements retain the target's mode with an explicit chmod, use a same-directory exclusive temporary file, and synchronously recheck that the target is a regular file immediately before rename.

## File tree changes

Use the toolbar or a folder row menu to create a folder, or the row menu to rename or confirm deletion. Folder deletion includes its contents. Drag a row onto a folder or the tree root to move it. Open tabs follow moves and renames and close on deletion.

Under `/api/files/<path>`, POST `?type=mkdir` takes `{ name }` at the parent; POST `?type=rename` takes `{ name }` at the entry; POST `?type=move` takes `{ directory }` at the entry. DELETE removes the entry itself; a real folder only with `?recursive=1`, which the client sends only after a folder was confirmed (otherwise 409), and asynchronously so a big tree does not stall other requests. Mutations are same-origin and confined to authorized roots. They refuse project/session roots and folders holding one, any `.git` path segment (any case, Windows trailing dots/spaces ignored), a folder that is or directly holds a checkout (own `.git`, e.g. `<repo>-worktrees/<branch>`), and a folder holding a linked worktree that `git worktree list` reports; links are operated on as links. Other nested repositories deeper inside a folder are not searched (a recursive walk would block the server on large trees). Cross-filesystem moves are refused.

## Git status

Untracked line totals use four asynchronous workers, each reusing a 64 KiB buffer. Reads stop at the initial file size; empty, NUL-containing, non-regular and over-preview-limit files count zero. Status path mapping yields every 1,000 entries and resolves the cwd/repository only once per request, while retaining the explorer's symlink spelling and renames leaving the cwd as deletions. Replaced explorer requests abort the server scan; open handles are always closed. Counts are fresh per request, not cached.

## Text encoding

Source previews recognize UTF-16LE/BE BOMs before binary detection. Pagination offsets remain byte offsets; chunk boundaries preserve UTF-8 sequences and UTF-16 surrogate pairs. UTF-16 without a BOM is not inferred.

## Mutable previews

Media/document URLs use page-wide monotonically increasing versions on reopen and file changes. Visibility alone never changes a mounted preview's URL/key, so unchanged playback and document reading positions survive tab switches (including hidden mounted previews). The existing heartbeat/reconnecting `FileWatchEventSource` recovers watches; a resumed/reconnected `connected` version is compared with the last seen version and only a changed file bumps the URL. No second reconnect mechanism is added. PDF page fragments remain separate from the cache-busting query.

## Diff rendering

Git diffs use paired old/new columns when the viewer content is at least 720 px wide (about 47 code columns a side; the default side panel stays unified). Both columns wrap, so the wrap toggle is hidden in split view. Narrower panels use the unified view and keep the user's wrap preference.

Added, removed and context text reuse Source's Prism pipeline and its light/dark styles. Language detection lives in `lib/file-types.ts` and is shared with the read route, so deleted files highlight without fetching missing content. Memoized inline line components reset theme pre/code geometry so gutters, row backgrounds and wrapping stay unchanged; Git mode/rename metadata stays plain. Diffs exceeding 1,000 rows or the 128 KiB UTF-8 highlighting budget fall back to plain text.

<!-- shortcut: line-by-line highlighting cannot track multiline comments/template strings; tokenize both full file versions if that becomes necessary. -->

## Windows shell paths

Markdown file links with a `:line` or `:start-end` suffix open in Source and mark the requested lines. Optional column numbers are ignored; the viewer reads more chunks only as needed to reach the end of the range.

File links and tool paths normalize `/d`, `/mnt/d` and `/cygdrive/d` to `D:/` only when the caller's cwd has a Windows drive letter. No browser OS inference is used: POSIX paths and UNC inputs retain their meaning. Cross-drive paths, drive roots and PDF page fragments work through the same resolvers.

## Session export

HTML exports create a private `mkdtemp` directory for each request, avoiding cross-user ownership conflicts and concurrent-export interference. The entire directory is removed in `finally`, including partial output after a failure. Markdown exports never create it.
