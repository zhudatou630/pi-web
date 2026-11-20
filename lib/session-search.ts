import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import type { SessionInfo } from "./types";
import { stripAnsi } from "./ansi";
import { getSessionDisplayTitle } from "./session-display-title";
import { isUnnamedSideChat } from "./session-family";
import { SIDE_CHAT_TYPE } from "./side-chat";

const MAX_FILES = 500;
const MAX_RESULTS = 30;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_LINE_CHARS = 1024 * 1024;
const TIME_BUDGET_MS = 3000;
const CACHE_UNITS = 32 * 1024 * 1024;

interface SearchMessage {
  entryId?: string;
  blocks: { text: string; blockIndex: number }[];
}

// ctime and inode catch a same-size rewrite that restored the old mtime, as lib/session-reader.ts does.
type FileStamp = { size: number; mtimeMs: number; ctimeMs: number; ino: number };

interface CachedTranscript {
  stamp: FileStamp;
  side: boolean;
  ownText: boolean;
  messages: SearchMessage[];
  units: number;
}

declare global {
  var __piSessionSearchCache: {
    entries: Map<string, CachedTranscript>;
    ranks: Map<string, number>;
    units: number;
  } | undefined;
}

const cache = (globalThis.__piSessionSearchCache ??= { entries: new Map(), ranks: new Map(), units: 0 });

export interface SessionSearchResult {
  session: SessionInfo;
  entryId?: string;
  blockIndex?: number;
  titleOnly?: boolean;
  before: string;
  match: string;
  after: string;
}

export interface SessionSearchResponse {
  results: SessionSearchResult[];
  truncated: boolean;
}

// Quotes delimit a phrase only at a term boundary; embedded quotes stay literal.
export function sessionSearchTerms(query: string): string[] {
  const terms = Array.from(query.matchAll(/"([^"]*)(?:"|$)|(\S+)/g), (match) => match[1] ?? match[2]).filter(Boolean);
  return [...new Set(terms.length ? terms : [query])];
}

async function fileStamp(path: string): Promise<FileStamp | undefined> {
  const stamp = await stat(path).catch(() => undefined);
  return stamp?.isFile() ? { size: stamp.size, mtimeMs: stamp.mtimeMs, ctimeMs: stamp.ctimeMs, ino: stamp.ino } : undefined;
}

function sameStamp(before: FileStamp, after: FileStamp | undefined) {
  return before.size === after?.size && before.mtimeMs === after.mtimeMs
    && before.ctimeMs === after.ctimeMs && before.ino === after.ino;
}

function dropCached(path: string) {
  const entry = cache.entries.get(path);
  if (!entry) return;
  cache.entries.delete(path);
  cache.units -= entry.units;
}

function rememberTranscript(path: string, entry: CachedTranscript) {
  // A newer listing can prune this path while its read is in flight.
  const rank = cache.ranks.get(path);
  if (rank === undefined) return;
  let excess = cache.units - (cache.entries.get(path)?.units ?? 0) + entry.units - CACHE_UNITS;
  if (excess > 0) {
    // Evict oldest first, and only if older entries alone can make enough room.
    const victims: string[] = [];
    const older = [...cache.ranks].slice(rank + 1).reverse();
    for (const [candidate] of older) {
      const cached = cache.entries.get(candidate);
      if (!cached) continue;
      victims.push(candidate);
      excess -= cached.units;
      if (excess <= 0) break;
    }
    if (excess > 0) return;
    for (const victim of victims) dropCached(victim);
  }
  dropCached(path);
  cache.entries.set(path, entry);
  cache.units += entry.units;
}

// Scan recent sessions without a search index; reuse only complete transcripts.
export async function searchSessionContents(
  sessions: readonly SessionInfo[],
  query: string,
  requestSignal?: AbortSignal,
): Promise<SessionSearchResponse> {
  const response: SessionSearchResponse = { results: [], truncated: false };
  const needle = query.trim();
  if (!needle) return response;
  if (needle.length > 200) throw new RangeError("Search query exceeds 200 characters");
  // Escape every operator: this is literal search, with offsets in the original text.
  const matchers = sessionSearchTerms(needle).map((term) => new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
  const deadline = Date.now() + TIME_BUDGET_MS;
  const timeout = AbortSignal.timeout(TIME_BUDGET_MS);
  const signal = requestSignal ? AbortSignal.any([requestSignal, timeout]) : timeout;
  const candidates = sessions
    .filter((session) => !session.transient && session.path)
    .sort((a, b) => b.modified.localeCompare(a.modified));

  const scoped = candidates.slice(0, MAX_FILES);
  if (!signal.aborted) {
    const ranks = new Map<string, number>();
    for (const { path } of scoped) if (!ranks.has(path)) ranks.set(path, ranks.size);
    cache.ranks = ranks;
    for (const path of cache.entries.keys()) if (!ranks.has(path)) dropCached(path);
  }
  if (candidates.length > scoped.length) response.truncated = true;

  for (const session of scoped) {
    if (response.results.length >= MAX_RESULTS || signal.aborted || Date.now() >= deadline) {
      response.truncated = true;
      break;
    }
    const side = session.relation?.kind === "side";
    const title = side ? (isUnnamedSideChat(session.name) ? "" : session.name!) : getSessionDisplayTitle(session);
    const titlePending = matchers.filter((matcher) => !matcher.test(title));
    let pending = titlePending;
    let snippet: SessionSearchResult | undefined;
    let found = false;
    let ownText = !side;
    const matchMessage = ({ entryId, blocks }: SearchMessage) => {
      const text = blocks.length === 1 ? blocks[0].text : blocks.map((block) => block.text).join("\n");
      pending = pending.filter((matcher) => !matcher.test(text));
      const match = snippet ? null : matchers.map((matcher) => matcher.exec(text)).find(Boolean);
      if (!match) return;
      const start = match.index;
      const end = start + match[0].length;
      let blockOffset = 0;
      const matchedBlock = blocks.find((block) => {
        const blockEnd = blockOffset + block.text.length;
        blockOffset = blockEnd + 1;
        return start <= blockEnd;
      });
      snippet = {
        session,
        ...(entryId !== undefined ? { entryId } : {}),
        blockIndex: matchedBlock!.blockIndex,
        before: (start > 80 ? "..." : "") + text.slice(Math.max(0, start - 80), start).replace(/\s+/g, " ").trimStart(),
        match: match[0].replace(/\s+/g, " "),
        after: text.slice(end, end + 80).replace(/\s+/g, " ").trimEnd() + (end + 80 < text.length ? "..." : ""),
      };
    };

    const stamp = await fileStamp(session.path);
    let cached = cache.entries.get(session.path);
    if (cached && (cached.side !== side || !sameStamp(cached.stamp, stamp))) {
      dropCached(session.path);
      cached = undefined;
    }
    let capped = false;
    let collected: CachedTranscript | undefined;
    if (cached) {
      if (signal.aborted || Date.now() >= deadline) {
        response.truncated = true;
        break;
      }
      ownText = cached.ownText;
      for (const message of cached.messages) {
        if (signal.aborted || Date.now() >= deadline) {
          response.truncated = true;
          break;
        }
        matchMessage(message);
        if (snippet && !pending.length) break;
      }
    } else {
      const stream = createReadStream(session.path, { encoding: "utf8", end: MAX_FILE_BYTES - 1, signal });
      const lines = createInterface({ input: stream, crlfDelay: Infinity });
      const baseUnits = 64 + session.path.length;
      if (stamp && stamp.size < MAX_FILE_BYTES) collected = { stamp, side, ownText, messages: [], units: baseUnits };
      try {
        for await (const line of lines) {
          if (signal.aborted || Date.now() >= deadline) {
            collected = undefined;
            response.truncated = true;
            break;
          }
          // Inherited lines are read but not parsed.
          if (!ownText && !line.includes(SIDE_CHAT_TYPE)) continue;
          if (line.length > MAX_LINE_CHARS) {
            collected = undefined;
            response.truncated = true;
            continue;
          }
          let entry;
          try { entry = JSON.parse(line); } catch { collected = undefined; continue; }
          if (side && entry?.type === "custom_message" && entry.customType === SIDE_CHAT_TYPE) {
            // A nested side chat starts over at its last boundary.
            ownText = true;
            pending = titlePending;
            snippet = undefined;
            if (collected) {
              collected.messages.length = 0;
              collected.units = baseUnits;
            }
            continue;
          }
          if (!ownText || entry?.type !== "message" || !["user", "assistant"].includes(entry.message?.role)) continue;
          const content: unknown = entry.message.content;
          const blocks = typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content : [];
          // Match what the chat shows: assistant text renders without terminal escapes.
          const shown = entry.message.role === "assistant" ? stripAnsi : (value: string) => value;
          const textBlocks = blocks.flatMap((block, blockIndex) => block?.type === "text" && typeof block.text === "string" ? [{ text: shown(block.text as string), blockIndex }] : []);
          if (!textBlocks.length) continue;
          const message: SearchMessage = { entryId: typeof entry.id === "string" ? entry.id : undefined, blocks: textBlocks };
          matchMessage(message);
          if (snippet && !pending.length && !side) {
            collected = undefined;
            break;
          }
          if (collected) {
            collected.units += 64 + (message.entryId?.length ?? 0) + textBlocks.reduce((units, block) => units + 16 + block.text.length, 0);
            if (collected.units <= CACHE_UNITS) collected.messages.push(message);
            else collected = undefined;
          }
        }
      } catch {
        // Missing/unreadable files and interrupted reads must not hide other results.
        collected = undefined;
        response.truncated = true;
      } finally {
        capped = stream.bytesRead >= MAX_FILE_BYTES;
        if (collected && (!stream.readableEnded || stream.bytesRead !== collected.stamp.size || capped)) collected = undefined;
        lines.close();
        stream.destroy();
      }
    }
    // A later boundary in the unread rest could still discard a side chat's match.
    if (side && snippet && (capped || signal.aborted || Date.now() >= deadline)) {
      snippet = undefined;
      response.truncated = true;
    }
    if (snippet && !pending.length) {
      response.results.push(snippet);
      found = true;
    }
    if (!found && capped) response.truncated = true;
    // The catalog already resolves the latest session_info; share the sidebar's fallback too.
    if (!found && ownText && !signal.aborted && Date.now() < deadline) {
      const hit = title && matchers.every((matcher) => matcher.test(title)) ? matchers[0].exec(title) : null;
      if (hit) response.results.push({
        session,
        titleOnly: true,
        before: title.slice(0, hit.index),
        match: hit[0],
        after: title.slice(hit.index + hit[0].length),
      });
    }
    // Do not publish text from a file that changed while the stream was open.
    if (collected && !signal.aborted) {
      const after = await fileStamp(session.path);
      if (!signal.aborted && sameStamp(collected.stamp, after)) {
        collected.ownText = ownText;
        rememberTranscript(session.path, collected);
      }
    }
  }
  return response;
}
