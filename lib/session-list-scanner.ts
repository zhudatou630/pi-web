// Cache session-list metadata without building the SDK's unused allMessagesText.
// Growing files resume after the last complete line; unchanged files only need stat.
// shortcut: same-inode edits outside the head/tail samples can look like appends;
// use full content hashes if detecting arbitrary in-place edits becomes necessary.
import { createHash } from "node:crypto";
import { createReadStream, existsSync, readFileSync } from "node:fs";
import { open, readdir, stat, type FileHandle } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { basename, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { writePrivateFileAtomicSync } from "./atomic-file";
import { getSessionFirstMessagePreview, SESSION_FIRST_MESSAGE_PREVIEW_MAX_LENGTH } from "./session-display-title";
import { IMAGE_RESULT_TYPE } from "./image-generation";
import { foldRoutineMarks, routineMarksInfo, type RoutineMarks } from "./routine-run-entry";

export interface ScannedSessionInfo {
	path: string;
	id: string;
	cwd: string;
	name?: string;
	created: Date;
	modified: Date;
	messageCount: number;
	firstMessage: string;
	parentSessionPath?: string;
	/** The routine whose runs prompted this session (latest), if any. */
	routineId?: string;
	/** A chat a routine run started for itself and nobody has written in: kept out of the sidebar lists. */
	routineRunOnly?: boolean;
}

interface Fingerprint {
	size: number;
	mtimeMs: number;
	ino: number;
	dev: number;
}

interface ScanState extends RoutineMarks {
	header: RawEntry | null;
	name?: string;
	messageCount: number;
	firstMessage: string;
	hasFirstMessage: boolean;
	lastActivityTime?: number;
}

interface ResumePoint {
	offset: number;
	head: string;
	tail: string;
	state: ScanState;
}

interface IndexEntry {
	fp: Fingerprint;
	info: ScannedSessionInfo;
	resume?: ResumePoint;
}

interface PendingIndexSave {
	path: string;
	index: Map<string, IndexEntry>;
	timer: NodeJS.Timeout;
}

type RawEntry = Record<string, unknown>;

function isRecord(value: unknown): value is RawEntry {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Bump when counting/preview rules change: resumed totals keep the old rules.
const INDEX_FORMAT_VERSION = 6;
const RESUME_SAMPLE_BYTES = 1024;
const INDEX_PERSIST_DELAY_MS = 5_000;

declare global {
	var __piWebScanIndex: Map<string, IndexEntry> | undefined;
	var __piWebScanIndexPath: string | undefined;
	var __piWebScanIndexSave: PendingIndexSave | undefined;
}

function parseLine(line: string): RawEntry | null {
	if (!line.trim()) return null;
	try {
		const entry = JSON.parse(line) as RawEntry;
		return entry && typeof entry === "object" ? entry : null;
	} catch {
		return null;
	}
}

function extractTextContent(message: RawEntry): string {
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter(
			(block): block is { type: string; text: string } =>
				!!block &&
				typeof block === "object" &&
				(block as RawEntry).type === "text" &&
				typeof (block as RawEntry).text === "string",
		)
		.map((block) => block.text)
		.join(" ");
}

function activityTimeOf(entry: RawEntry): number | undefined {
	const message = entry.message as RawEntry | undefined;
	if (
		!message ||
		typeof message.role !== "string" ||
		!("content" in message) ||
		(message.role !== "user" && message.role !== "assistant")
	) {
		return undefined;
	}
	if (typeof message.timestamp === "number") return message.timestamp;
	const t = new Date(entry.timestamp as string).getTime();
	return Number.isNaN(t) ? undefined : t;
}

// Keep the existing title, preview, image-result and activity rules in one fold.
function foldLine(state: ScanState, bytes: Buffer): boolean {
	const entry = parseLine(bytes.toString("utf8"));
	if (!entry) return true;
	if (!state.header) {
		if (entry.type !== "session") return false;
		state.header = {
			id: entry.id,
			cwd: typeof entry.cwd === "string" ? entry.cwd : "",
			timestamp: entry.timestamp,
			parentSession: typeof entry.parentSession === "string" ? entry.parentSession : undefined,
		};
		return true;
	}
	if (entry.type === "session_info") {
		state.name = typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : undefined;
	}
	if (entry.type === "custom_message" && entry.customType === IMAGE_RESULT_TYPE) {
		state.messageCount++;
		const activityTime = new Date(entry.timestamp as string).getTime();
		if (!Number.isNaN(activityTime)) state.lastActivityTime = Math.max(state.lastActivityTime ?? 0, activityTime);
		const details = entry.details as RawEntry | undefined;
		if (!state.hasFirstMessage && typeof details?.prompt === "string" && details.prompt) {
			state.hasFirstMessage = true;
			state.firstMessage = getSessionFirstMessagePreview(details.prompt);
		}
		return true;
	}
	foldRoutineMarks(state, entry);
	if (entry.type !== "message") return true;
	state.messageCount++;
	const activityTime = activityTimeOf(entry);
	if (typeof activityTime === "number") state.lastActivityTime = Math.max(state.lastActivityTime ?? 0, activityTime);
	const message = entry.message as RawEntry | undefined;
	if (!state.hasFirstMessage && message?.role === "user" && "content" in message) {
		const text = extractTextContent(message);
		if (text) {
			state.hasFirstMessage = true;
			state.firstMessage = getSessionFirstMessagePreview(text);
		}
	}
	return true;
}

function sampleHash(bytes: Buffer): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function appendSample(previous: Buffer, bytes: Buffer): Buffer {
	return bytes.length >= RESUME_SAMPLE_BYTES
		? bytes.subarray(-RESUME_SAMPLE_BYTES)
		: Buffer.concat([previous, bytes]).subarray(-RESUME_SAMPLE_BYTES);
}

async function sampleAt(handle: FileHandle, start: number, length: number): Promise<Buffer> {
	const bytes = Buffer.alloc(length);
	const { bytesRead } = await handle.read(bytes, 0, length, start);
	if (bytesRead !== length) throw new Error("Session changed during scan");
	return bytes;
}

async function resumeSamples(handle: FileHandle, offset: number): Promise<{ head: Buffer; tail: Buffer }> {
	const length = Math.min(offset, RESUME_SAMPLE_BYTES);
	const [head, tail] = await Promise.all([
		sampleAt(handle, 0, length),
		sampleAt(handle, offset - length, length),
	]);
	return { head, tail };
}

async function scanSessionFile(filePath: string, previous?: IndexEntry): Promise<IndexEntry | null> {
	let handle: FileHandle | undefined;
	try {
		// Validate and stream the same inode, even if the path is replaced mid-scan.
		handle = await open(filePath, "r");
		const stats = await handle.stat();
		const fp: Fingerprint = { size: stats.size, mtimeMs: stats.mtimeMs, ino: stats.ino, dev: stats.dev };
		let offset = 0;
		let headerSampled = false;
		let head: Buffer = Buffer.alloc(0);
		let tail: Buffer = Buffer.alloc(0);
		let state: ScanState = { header: null, messageCount: 0, firstMessage: "", hasFirstMessage: false };
		if (previous?.resume && fp.ino > 0 && fp.ino === previous.fp.ino && fp.dev === previous.fp.dev
			&& fp.size > previous.fp.size && fp.size >= previous.resume.offset) {
			const samples = await resumeSamples(handle, previous.resume.offset);
			if (sampleHash(samples.head) === previous.resume.head && sampleHash(samples.tail) === previous.resume.tail) {
				offset = previous.resume.offset;
				headerSampled = true;
				head = samples.head;
				tail = samples.tail;
				state = { ...previous.resume.state };
			}
		}

		let pending: Buffer[] = [];
		let recent = tail;
		if (fp.size > offset) {
			const stream = createReadStream(filePath, { fd: handle.fd, autoClose: false, start: offset, end: fp.size - 1 });
			for await (const chunk of stream as AsyncIterable<Buffer>) {
				if (head.length < RESUME_SAMPLE_BYTES) {
					head = Buffer.concat([head, chunk.subarray(0, RESUME_SAMPLE_BYTES - head.length)]);
				}
				let start = 0;
				let lf = chunk.indexOf(0x0a);
				let cr = chunk.indexOf(0x0d);
				while (lf !== -1 || cr !== -1) {
					const end = lf === -1 ? cr : cr === -1 ? lf : Math.min(lf, cr);
					const piece = chunk.subarray(start, end);
					const bytes = pending.length ? Buffer.concat([...pending, piece]) : piece;
					const hadHeader = state.header !== null;
					if (!foldLine(state, bytes)) return null;
					offset += bytes.length + 1;
					if (!hadHeader && state.header) headerSampled = offset <= RESUME_SAMPLE_BYTES;
					pending = [];
					start = end + 1;
					if (end === lf) lf = chunk.indexOf(0x0a, start);
					if (end === cr) cr = chunk.indexOf(0x0d, start);
				}
				// Bind the checkpoint to parsed bytes, never to a later disk read.
				if (start > 0) tail = appendSample(recent, chunk.subarray(Math.max(0, start - RESUME_SAMPLE_BYTES), start));
				recent = appendSample(recent, chunk);
				if (start < chunk.length) pending.push(chunk.subarray(start));
			}
		}
		// A valid JSON entry without a newline still displays, but never advances
		// the checkpoint: completing/replacing that last line must not double-count.
		const visible = { ...state };
		if (pending.length && !foldLine(visible, Buffer.concat(pending))) return null;
		const header = visible.header;
		if (!header) return null;
		const headerTime = typeof header.timestamp === "string" ? new Date(header.timestamp).getTime() : NaN;
		const modified = typeof visible.lastActivityTime === "number" && visible.lastActivityTime > 0
			? new Date(visible.lastActivityTime)
			: !Number.isNaN(headerTime) ? new Date(headerTime) : stats.mtime;
		return {
			fp,
			info: {
				path: filePath,
				id: header.id as string,
				cwd: header.cwd as string,
				name: visible.name,
				parentSessionPath: header.parentSession as string | undefined,
				created: new Date(header.timestamp as string),
				modified,
				messageCount: visible.messageCount,
				firstMessage: visible.hasFirstMessage ? visible.firstMessage : "(no messages)",
				...routineMarksInfo(visible, typeof header.parentSession === "string"),
			},
			// shortcut: headers beyond the 1 KiB sample use full scans; enlarge the sample if needed.
			resume: headerSampled && fp.ino > 0 ? {
				offset,
				head: sampleHash(head.subarray(0, Math.min(offset, RESUME_SAMPLE_BYTES))),
				tail: sampleHash(tail),
				state,
			} : undefined,
		};
	} catch {
		return null;
	} finally {
		await handle?.close().catch(() => undefined);
	}
}

/** Full-scan entry point used by callers that need fresh metadata for one file. */
export async function scanSessionFileInfo(filePath: string): Promise<ScannedSessionInfo | null> {
	return (await scanSessionFile(filePath))?.info ?? null;
}

async function enumerateSessionFiles(sessionsDir: string): Promise<string[]> {
	let dirs: Dirent[];
	try {
		const entries = await readdir(sessionsDir, { withFileTypes: true });
		dirs = entries.filter(
			(entry) => entry.isDirectory() || entry.isSymbolicLink(),
		);
	} catch {
		return [];
	}

	const files: string[] = [];
	for (const dir of dirs) {
		const dirPath = join(sessionsDir, dir.name);
		try {
			for (const f of await readdir(dirPath)) {
				if (f.endsWith(".jsonl")) files.push(join(dirPath, f));
			}
		} catch {
			// unreadable project dir: same skip-as-absent semantics as the SDK
		}
	}
	return files;
}

const MAX_CONCURRENT_SCANS = 10;

async function runPool<T>(items: T[], worker: (item: T) => Promise<void>) {
	let next = 0;
	const inFlight = new Set<Promise<void>>();
	while (next < items.length || inFlight.size > 0) {
		while (next < items.length && inFlight.size < MAX_CONCURRENT_SCANS) {
			const item = items[next++];
			const task = worker(item).finally(() => inFlight.delete(task));
			inFlight.add(task);
		}
		if (inFlight.size > 0) await Promise.race(inFlight);
	}
}

function getIndex(): Map<string, IndexEntry> {
	if (!globalThis.__piWebScanIndex) globalThis.__piWebScanIndex = new Map();
	return globalThis.__piWebScanIndex;
}

function indexFilePath(agentDir: string): string {
	return join(agentDir, "pi-web-session-index.json");
}

function readResumePoint(value: unknown, size: number): ResumePoint | undefined {
	if (!isRecord(value) || !isRecord(value.state)) return undefined;
	const { offset, head, tail, state } = value;
	const { header, name, messageCount, firstMessage, hasFirstMessage, lastActivityTime, routineId, routineMode, routinePending, routineStarted, userReplied } = state;
	if (
		typeof offset !== "number" || !Number.isSafeInteger(offset) || offset <= 0 || offset > size ||
		typeof head !== "string" || !/^[a-f0-9]{64}$/.test(head) ||
		typeof tail !== "string" || !/^[a-f0-9]{64}$/.test(tail) ||
		!isRecord(header) || typeof header.id !== "string" || typeof header.cwd !== "string" ||
		typeof header.timestamp !== "string" || !Number.isFinite(Date.parse(header.timestamp)) ||
		(header.parentSession !== undefined && typeof header.parentSession !== "string") ||
		(name !== undefined && typeof name !== "string") ||
		typeof messageCount !== "number" || !Number.isSafeInteger(messageCount) || messageCount < 0 ||
		typeof firstMessage !== "string" || firstMessage.length > SESSION_FIRST_MESSAGE_PREVIEW_MAX_LENGTH || typeof hasFirstMessage !== "boolean" ||
		(lastActivityTime !== undefined && (typeof lastActivityTime !== "number" || !Number.isFinite(lastActivityTime))) ||
		(routineId !== undefined && typeof routineId !== "string") ||
		(routineMode !== undefined && typeof routineMode !== "string") ||
		[routinePending, routineStarted, userReplied].some((flag) => flag !== undefined && typeof flag !== "boolean")
	) return undefined;
	const flag = (value: unknown) => value as boolean | undefined; // checked just above
	return { offset, head, tail, state: { header, name, messageCount, firstMessage, hasFirstMessage, lastActivityTime, routineId, routineMode, routinePending: flag(routinePending), routineStarted: flag(routineStarted), userReplied: flag(userReplied) } };
}

function loadPersistedIndex(path: string): void {
	if (globalThis.__piWebScanIndexPath === path) return;
	persistIndex();
	globalThis.__piWebScanIndex = new Map();
	globalThis.__piWebScanIndexPath = path;
	if (!existsSync(path)) return;
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (!isRecord(parsed) || parsed.version !== INDEX_FORMAT_VERSION || !isRecord(parsed.entries)) return;
		const index = getIndex();
		for (const [pathKey, entry] of Object.entries(parsed.entries)) {
			if (!isRecord(entry) || !isRecord(entry.fp) || !isRecord(entry.info)) continue;
			const { fp, info } = entry;
			if (
				typeof fp.size !== "number" || !Number.isSafeInteger(fp.size) || fp.size < 0 ||
				typeof fp.mtimeMs !== "number" || !Number.isFinite(fp.mtimeMs) ||
				typeof fp.ino !== "number" || !Number.isSafeInteger(fp.ino) || fp.ino < 0 ||
				typeof fp.dev !== "number" || !Number.isSafeInteger(fp.dev) || fp.dev < 0 ||
				info.path !== pathKey ||
				typeof info.id !== "string" ||
				typeof info.cwd !== "string" ||
				typeof info.firstMessage !== "string" ||
				(info.name !== undefined && typeof info.name !== "string") ||
				(info.parentSessionPath !== undefined && typeof info.parentSessionPath !== "string") ||
				(info.routineId !== undefined && typeof info.routineId !== "string") ||
				(info.routineRunOnly !== undefined && typeof info.routineRunOnly !== "boolean") ||
				typeof info.messageCount !== "number" || !Number.isSafeInteger(info.messageCount) || info.messageCount < 0 ||
				typeof info.created !== "string" || typeof info.modified !== "string"
			) continue;
			const created = new Date(info.created);
			const modified = new Date(info.modified);
			if (!Number.isFinite(created.getTime()) || !Number.isFinite(modified.getTime())) continue;
			const resume = readResumePoint(entry.resume, fp.size);
			if (entry.resume !== undefined && !resume) continue;
			index.set(pathKey, {
				fp: { size: fp.size, mtimeMs: fp.mtimeMs, ino: fp.ino, dev: fp.dev },
				resume,
				info: {
					path: pathKey,
					id: info.id,
					cwd: info.cwd,
					name: info.name,
					parentSessionPath: info.parentSessionPath,
					...(typeof info.routineId === "string" ? { routineId: info.routineId } : {}),
					...(info.routineRunOnly === true ? { routineRunOnly: true } : {}),
					firstMessage: info.firstMessage,
					messageCount: info.messageCount,
					created,
					modified,
				},
			});
		}
	} catch {
		// corrupt index => cold rebuild, never an error surfaced to callers
	}
}

function persistIndex(): void {
	const pending = globalThis.__piWebScanIndexSave;
	if (!pending) return;
	clearTimeout(pending.timer);
	globalThis.__piWebScanIndexSave = undefined;
	try {
		writePrivateFileAtomicSync(
			pending.path,
			JSON.stringify({ version: INDEX_FORMAT_VERSION, entries: Object.fromEntries(pending.index) }),
		);
	} catch {
		// persistence is best-effort; the in-memory index remains authoritative
	}
}

function queueIndexPersist(path: string, index: Map<string, IndexEntry>): void {
	const pending = globalThis.__piWebScanIndexSave;
	if (pending?.path === path && pending.index === index) return;
	persistIndex();
	const timer = setTimeout(persistIndex, INDEX_PERSIST_DELAY_MS);
	// Losing a pending write on exit only costs a rescan, not session data.
	timer.unref();
	globalThis.__piWebScanIndexSave = { path, index, timer };
}

/**
 * Incremental equivalent of SessionManager.listAll(): rescans only files whose
 * (size, mtimeMs, ino, dev) changed since the last pass. Growing files resume
 * when their sampled prefix is unchanged. Output ordering matches the SDK
 * catalogue (modified descending).
 */
export async function listSessionsIncremental(): Promise<ScannedSessionInfo[]> {
	const agentDir = getAgentDir();
	const persistPath = indexFilePath(agentDir);
	loadPersistedIndex(persistPath);
	const index = getIndex();

	const sessionsDir = join(agentDir, "sessions");
	const files = await enumerateSessionFiles(sessionsDir);
	if (globalThis.__piWebScanIndexPath === persistPath) {
		globalThis.__piSessionMembership = { files: new Set(files) };
	}

	const present = new Set(files);
	const stale: string[] = [];
	for (const known of index.keys()) {
		if (!present.has(known)) stale.push(known);
	}
	for (const pathKey of stale) index.delete(pathKey);

	const fingerprints = await Promise.all(
		files.map(async (filePath) => {
			try {
				const s = await stat(filePath);
				return {
					filePath,
					fp: { size: s.size, mtimeMs: s.mtimeMs, ino: s.ino, dev: s.dev } as Fingerprint,
				};
			} catch {
				return { filePath, fp: null as Fingerprint | null };
			}
		}),
	);

	const changed: Array<{ filePath: string; resultIndex: number }> = [];
	const results: (ScannedSessionInfo | null)[] = new Array(files.length).fill(null);
	// Persist only when the index really changed: a file that keeps failing to scan
	// (never indexed) must not rewrite the whole index on every pass.
	let mutated = stale.length > 0;
	for (const [resultIndex, { filePath, fp }] of fingerprints.entries()) {
		if (!fp) {
			if (index.delete(filePath)) mutated = true;
			continue;
		}
		const cached = index.get(filePath);
		if (
			cached &&
			cached.fp.size === fp.size &&
			cached.fp.mtimeMs === fp.mtimeMs &&
			cached.fp.ino === fp.ino &&
			cached.fp.dev === fp.dev
		) {
			results[resultIndex] = cached.info;
			continue;
		}
		changed.push({ filePath, resultIndex });
	}

	await runPool(changed, async ({ filePath, resultIndex }) => {
		const scanned = await scanSessionFile(filePath, index.get(filePath));
		if (scanned) {
			index.set(filePath, scanned);
			results[resultIndex] = scanned.info;
			mutated = true;
		} else if (index.delete(filePath)) {
			mutated = true;
		}
	});

	if (mutated) queueIndexPersist(persistPath, index);

	// Pi 0.86 discovers files by filesystem mtime before sorting session metadata.
	// Keep that order even when the metadata timestamps are equal or cached.
	return results.filter((info) => info !== null)
		.sort((a, b) => {
			const aIndex = index.get(a.path);
			const bIndex = index.get(b.path);
			const aMtime = aIndex?.fp.mtimeMs ?? 0;
			const bMtime = bIndex?.fp.mtimeMs ?? 0;
			return b.modified.getTime() - a.modified.getTime()
				|| bMtime - aMtime
				|| basename(b.path).localeCompare(basename(a.path));
		});
}

/** Test seam: persist without waiting for the throttle. */
export function flushSessionScanIndexForTests(): void {
	persistIndex();
}

/** Test seam: drop all in-memory index state and cancel pending saves. */
export function resetSessionScanIndexForTests(): void {
	clearTimeout(globalThis.__piWebScanIndexSave?.timer);
	globalThis.__piWebScanIndex = undefined;
	globalThis.__piWebScanIndexPath = undefined;
	globalThis.__piWebScanIndexSave = undefined;
	globalThis.__piSessionMembership = undefined;
	globalThis.__piSessionMembershipCheck = undefined;
}

// ============================================================================
// Filename membership: sessions another process creates or deletes.
// ============================================================================

declare global {
	/** The session files the last scan listed (or the last change a check reported). */
	var __piSessionMembership: { files: Set<string> } | undefined;
	var __piSessionMembershipCheck: { at: number; busy: boolean } | undefined;
}

export const SESSION_MEMBERSHIP_CHECK_MS = 1_000;

/**
 * Compare the session files on disk with the last scan's and call `onChange`
 * once when they differ. Directory reads only: appends to a transcript never
 * change its name, so a running session costs nothing here. At most one check
 * per SESSION_MEMBERSHIP_CHECK_MS, never two at once, and none before the
 * first scan. Returns the check's promise, or undefined when none started.
 */
export function checkSessionMembership(
	sessionsDir: string,
	onChange: () => void,
	now = Date.now(),
): Promise<void> | undefined {
	const known = globalThis.__piSessionMembership;
	const state = (globalThis.__piSessionMembershipCheck ??= { at: Number.NEGATIVE_INFINITY, busy: false });
	if (!known || state.busy || now - state.at < SESSION_MEMBERSHIP_CHECK_MS) return undefined;
	state.busy = true;
	state.at = now;
	return enumerateSessionFiles(sessionsDir)
		.then((files) => {
			// A scan recorded while this read ran replaces the baseline: drop this
			// result, the next check compares against the scan's own listing.
			if (globalThis.__piSessionMembership !== known) return;
			if (known.files.size === files.length && files.every((file) => known.files.has(file))) return;
			// Record the change so it bumps once, not on every check until a rescan.
			globalThis.__piSessionMembership = { files: new Set(files) };
			onChange();
		})
		.catch(() => undefined)
		.finally(() => {
			state.busy = false;
		});
}
