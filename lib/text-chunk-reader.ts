export interface TextChunk {
  content: string;
  nextOffset: number;
  truncated: boolean;
  version: string;
  error?: string;
}

export type ChunkReadResult<T extends TextChunk> =
  | { kind: "loaded"; append: boolean; chunk: T }
  | { kind: "error"; error: string }
  | { kind: "superseded" };

const MAX_RESTARTS = 3;

/**
 * Reads chunks until `minBytes` and returns them as one chunk, so a caller publishes once.
 * With `append`, reading continues from `startOffset` of the shown `version`; a changed
 * file or rejected offset restarts from 0 (replacing instead). A file that keeps changing
 * after a few restarts yields the consistent prefix read so far.
 */
export async function readTextChunks<T extends TextChunk>(
  readAt: (offset: number) => Promise<T>,
  options: { startOffset: number; version: string | null; minBytes: number; lines?: { completed: number; target: number }; isCurrent: () => boolean },
): Promise<ChunkReadResult<T>> {
  let append = options.startOffset > 0;
  let version = append ? options.version : null;
  let offset = append ? options.startOffset : 0;
  let content = "";
  let last: T | null = null;
  let completed = append ? options.lines?.completed ?? 0 : 0;
  let restarts = 0;
  for (;;) {
    const next = await readAt(offset);
    if (!options.isCurrent()) return { kind: "superseded" };
    const changed = offset > 0 && (next.error === "Invalid text preview offset" || (!next.error && next.version !== version));
    if (changed && restarts < MAX_RESTARTS) {
      restarts += 1;
      append = false;
      version = null;
      offset = 0;
      content = "";
      completed = 0;
      last = null;
      continue;
    }
    if (changed && last) break;
    if (next.error) return { kind: "error", error: next.error };
    version = next.version;
    content += next.content;
    last = next;
    if (options.lines) {
      for (let i = next.content.indexOf("\n"); i !== -1; i = next.content.indexOf("\n", i + 1)) completed++;
      if (completed >= options.lines.target) break;
    }
    // A chunk that does not advance would repeat forever.
    if (!next.truncated || next.nextOffset >= options.minBytes || next.nextOffset <= offset) break;
    offset = next.nextOffset;
  }
  return { kind: "loaded", append, chunk: { ...last, content } };
}
