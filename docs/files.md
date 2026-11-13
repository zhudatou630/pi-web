# File access and previews

## Git status

Untracked line totals use four asynchronous workers, each reusing a 64 KiB buffer. Reads stop at the initial file size; empty, NUL-containing, non-regular and over-preview-limit files count zero. Status path mapping yields every 1,000 entries and resolves the cwd/repository only once per request, while retaining the explorer's symlink spelling and renames leaving the cwd as deletions. Replaced explorer requests abort the server scan; open handles are always closed. Counts are fresh per request, not cached.

## Session export

HTML exports create a private `mkdtemp` directory for each request, avoiding cross-user ownership conflicts and concurrent-export interference. The entire directory is removed in `finally`, including partial output after a failure. Markdown exports never create it.
