# File access and previews

## Git status

Untracked line totals use four asynchronous workers, each reusing a 64 KiB buffer. Reads stop at the initial file size; empty, NUL-containing, non-regular and over-preview-limit files count zero. Status path mapping yields every 1,000 entries and resolves the cwd/repository only once per request, while retaining the explorer's symlink spelling and renames leaving the cwd as deletions. Replaced explorer requests abort the server scan; open handles are always closed. Counts are fresh per request, not cached.

## Mutable previews

Media/document URLs use page-wide monotonically increasing versions on reopen and file changes. Visibility alone never changes a mounted preview's URL/key, so unchanged playback and document reading positions survive tab switches (including hidden mounted previews). The existing heartbeat/reconnecting `FileWatchEventSource` recovers watches; a resumed/reconnected `connected` version is compared with the last seen version and only a changed file bumps the URL. No second reconnect mechanism is added. PDF page fragments remain separate from the cache-busting query.

## Diff rendering

Added, removed and context text reuse Source's Prism pipeline and both palettes. Language detection lives in `lib/file-types.ts` and is shared with the read route, so deleted files highlight without fetching missing content. Memoized inline line components reset theme pre/code geometry so gutters, row backgrounds and wrapping stay unchanged; Git mode/rename metadata stays plain. Diffs exceeding 1,000 rows or the 128 KiB UTF-8 highlighting budget fall back to plain text.

<!-- shortcut: line-by-line highlighting cannot track multiline comments/template strings; tokenize both full file versions if that becomes necessary. -->

## Windows shell paths

File links and tool paths normalize `/d`, `/mnt/d` and `/cygdrive/d` to `D:/` only when the caller's cwd has a Windows drive letter. No browser OS inference is used: POSIX paths and UNC inputs retain their meaning. Cross-drive paths, drive roots and PDF page fragments work through the same resolvers.

## Session export

HTML exports create a private `mkdtemp` directory for each request, avoiding cross-user ownership conflicts and concurrent-export interference. The entire directory is removed in `finally`, including partial output after a failure. Markdown exports never create it.
