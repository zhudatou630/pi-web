import { partitionAssistantMessage } from "./message-display";
import type { AssistantMessage } from "./types";

export const MARKDOWN_IMAGE_PLACEHOLDER = "[image]";

export type SessionMarkdownExportEntry = {
  id: string;
  parentId?: string | null;
  type: string;
  timestamp?: string;
  name?: string;
  message?: {
    role?: string;
    content?: unknown;
    model?: string;
    provider?: string;
  };
};

export type SessionMarkdownExportOptions = {
  leafId?: string | null;
  title?: string;
  exportedAt?: Date;
  sessionId?: string;
  /** Session header timestamp. */
  createdAt?: string;
  /** UI locale; picks the question label. */
  locale?: string;
  /** Minutes east of UTC (e.g. 480 for UTC+8). Null/invalid falls back to UTC. */
  timezoneOffsetMinutes?: number | null;
};

export type SessionMarkdownExportResult =
  | { ok: true; markdown: string; fileName: string; title: string; turns: number }
  | { ok: false; error: "empty" };

type DialogueRound = {
  title: string;
  question: string;
  answer: string;
};

const TITLE_LIMIT = 44;
const FILE_STEM_LIMIT = 60;
const MAX_TIMEZONE_OFFSET_MINUTES = 24 * 60;
const FENCE_LINE = /^\s*(`{3,}|~{3,})/;

export function sanitizeExportFileName(name: string, limit = FILE_STEM_LIMIT): string {
  const cleaned = name
    .replace(/[/\\:*?"<>|]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/ /g, "_");
  const stem = cleaned.slice(0, limit);
  return stem || "session";
}

export function buildSessionMarkdown(
  entries: readonly SessionMarkdownExportEntry[],
  options: SessionMarkdownExportOptions = {},
): SessionMarkdownExportResult {
  const branch = activeBranch(entries, options.leafId);
  const rounds = buildRounds(branch);
  if (rounds.length === 0) return { ok: false, error: "empty" };

  const exportedAt = options.exportedAt ?? new Date();
  const timezoneOffsetMinutes = normalizeTimezoneOffset(options.timezoneOffsetMinutes);
  const title = options.title?.trim()
    || sessionNameFromEntries(entries)
    || rounds[0]!.title
    || "session";
  const model = lastModelOf(branch);

  const markdown = normalizeMarkdown([
    renderFrontmatter({
      title,
      exportedAt,
      createdAt: parseDate(options.createdAt),
      sessionId: options.sessionId,
      timezoneOffsetMinutes,
      model,
      turns: rounds.length,
    }),
    "",
    `# ${title}`,
    "",
    rounds.map((round, index) => renderRound(round, index + 1, questionLabel(options.locale))).join("\n\n---\n\n"),
  ].join("\n")) + "\n";

  const date = localDatePart(exportedAt, timezoneOffsetMinutes);
  return {
    ok: true,
    markdown,
    fileName: `${date}_${sanitizeExportFileName(title)}.md`,
    title,
    turns: rounds.length,
  };
}

function renderFrontmatter(fields: {
  title: string;
  exportedAt: Date;
  createdAt?: Date;
  sessionId?: string;
  timezoneOffsetMinutes: number | null;
  model: string;
  turns: number;
}): string {
  const lines = [
    "---",
    `title: ${yamlScalar(fields.title)}`,
    `date: ${formatYamlTimestamp(fields.exportedAt, fields.timezoneOffsetMinutes)}`,
  ];
  if (fields.createdAt) lines.push(`created: ${formatYamlTimestamp(fields.createdAt, fields.timezoneOffsetMinutes)}`);
  if (fields.sessionId) lines.push(`session: ${yamlScalar(fields.sessionId)}`);
  if (fields.model) lines.push(`model: ${yamlScalar(fields.model)}`);
  lines.push(`turns: ${fields.turns}`, "---");
  return lines.join("\n");
}

function parseDate(value: string | undefined): Date | undefined {
  const date = value ? new Date(value) : undefined;
  return date && Number.isFinite(date.getTime()) ? date : undefined;
}

function questionLabel(locale: string | undefined): string {
  return locale?.toLowerCase().startsWith("zh") ? "问：" : "Q:";
}

function yamlScalar(value: string): string {
  const flattened = value.replace(/\s+/g, " ").trim();
  return `'${flattened.replace(/'/g, "''")}'`;
}

function formatYamlTimestamp(date: Date, offsetMinutes: number | null): string {
  const base = shiftDate(date, offsetMinutes).toISOString().replace(/\.\d{3}Z$/, "");
  if (offsetMinutes === null) return `${base}Z`;
  const sign = offsetMinutes < 0 ? "-" : "+";
  const abs = Math.abs(offsetMinutes);
  const hours = String(Math.floor(abs / 60)).padStart(2, "0");
  const minutes = String(abs % 60).padStart(2, "0");
  return `${base}${sign}${hours}:${minutes}`;
}

function localDatePart(date: Date, offsetMinutes: number | null): string {
  return shiftDate(date, offsetMinutes).toISOString().slice(0, 10);
}

function shiftDate(date: Date, offsetMinutes: number | null): Date {
  return offsetMinutes === null ? date : new Date(date.getTime() + offsetMinutes * 60_000);
}

function normalizeTimezoneOffset(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const rounded = Math.round(value);
  return Math.abs(rounded) <= MAX_TIMEZONE_OFFSET_MINUTES ? rounded : null;
}

function activeBranch(
  entries: readonly SessionMarkdownExportEntry[],
  leafId?: string | null,
): SessionMarkdownExportEntry[] {
  if (entries.length === 0) return [];
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  let current: SessionMarkdownExportEntry | undefined = (leafId ? byId.get(leafId) : undefined) ?? entries.at(-1);
  const chain: SessionMarkdownExportEntry[] = [];
  while (current) {
    chain.push(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  chain.reverse();
  return chain;
}

function sessionNameFromEntries(entries: readonly SessionMarkdownExportEntry[]): string | undefined {
  let name: string | undefined;
  for (const entry of entries) {
    if (entry.type === "session_info" && typeof entry.name === "string" && entry.name.trim()) {
      name = entry.name.trim();
    }
  }
  return name;
}

function lastModelOf(entries: readonly SessionMarkdownExportEntry[]): string {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
    const model = typeof entry.message.model === "string" ? entry.message.model : "";
    if (!model) continue;
    const provider = typeof entry.message.provider === "string" ? entry.message.provider : "";
    return provider ? `${provider}/${model}` : model;
  }
  return "";
}

function buildRounds(entries: readonly SessionMarkdownExportEntry[]): DialogueRound[] {
  const rounds: DialogueRound[] = [];
  let current: DialogueRound | null = null;

  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const role = entry.message?.role;
    if (role === "user") {
      const text = extractText(entry.message?.content);
      current = { title: dialogueTitle(text), question: text, answer: "" };
      rounds.push(current);
      continue;
    }
    if (role !== "assistant" || !current) continue;
    // Same answer the chat shows: trailing text plus long process notes, never the
    // short narration between tool calls that the UI folds away.
    const content = entry.message?.content;
    const answer = Array.isArray(content)
      ? partitionAssistantMessage(entry.message as unknown as AssistantMessage).answerMessage?.content
      : content;
    const text = extractText(answer);
    if (!text.trim()) continue;
    current.answer = current.answer
      ? `${current.answer}\n\n${text}`
      : text;
  }

  return rounds.filter((round) => round.answer.trim());
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const type = "type" in block ? block.type : undefined;
    if (type === "text" && "text" in block && typeof block.text === "string") {
      parts.push(block.text);
    } else if (type === "image") {
      parts.push(MARKDOWN_IMAGE_PLACEHOLDER);
    }
  }
  return parts.join("\n\n");
}

function dialogueTitle(markdown: string): string {
  for (const line of normalizeMarkdown(markdown).split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed === MARKDOWN_IMAGE_PLACEHOLDER) continue;
    if (FENCE_LINE.test(line)) continue;
    if (/^([-*>]|\d+[.)])$/.test(trimmed)) continue;
    let title = trimmed
      .replace(/^#{1,6}\s+/, "")
      .replace(/^[-*>]\s+/, "")
      .replace(/^\d+[.)]\s+/, "");
    title = title.replace(/[`*_]/g, "").replace(/\s+/g, " ").trim();
    if (!title) continue;
    return title.length > TITLE_LIMIT ? `${title.slice(0, TITLE_LIMIT)}…` : title;
  }
  return markdown.includes(MARKDOWN_IMAGE_PLACEHOLDER) ? "image" : "Untitled";
}

function renderRound(round: DialogueRound, index: number, label: string): string {
  const lines = [`## ${index}. ${round.title}`, ""];
  const question = normalizeMarkdown(round.question);
  if (question && question !== round.title) {
    const firstLine = question.split("\n")[0]!;
    const secondLine = question.split("\n")[1] ?? "";
    const startsWithBlock = /^(?: {4}|\t| {0,3}(?:#{1,6}\s|`{3,}|~{3,}|[-+*]\s|\d+[.)]\s|>|\||\[[^\]]+\]:|(?:\*\s*){3,}$|(?:-\s*){3,}$|(?:_\s*){3,}$))/.test(firstLine)
      || (firstLine.includes("|") && /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)+\|?\s*$/.test(secondLine));
    lines.push(toBlockquote(`**${label}**${startsWithBlock ? "\n\n" : " "}${question}`), "");
  }
  lines.push(rebaseHeadings(round.answer, 2));
  return lines.join("\n");
}

function toBlockquote(markdown: string): string {
  return markdown
    .split("\n")
    .map((line) => (line.trim() ? `> ${line}` : ">"))
    .join("\n");
}

export function rebaseHeadings(markdown: string, wrapperLevel = 2): string {
  const lines = normalizeMarkdown(markdown).split("\n");
  let fenceMarker = "";
  const headings = new Map<number, RegExpExecArray>();
  let minLevel = 7;
  lines.forEach((line, index) => {
    const fence = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fenceMarker) {
      if (fence && fence[1]![0] === fenceMarker[0]
        && fence[1]!.length >= fenceMarker.length && !fence[2]!.trim()) fenceMarker = "";
      return;
    }
    if (fence) {
      fenceMarker = fence[1]!;
      return;
    }
    const heading = /^(#{1,6})(\s+.*)$/.exec(line);
    if (heading) {
      headings.set(index, heading);
      minLevel = Math.min(minLevel, heading[1]!.length);
    }
  });
  const firstChild = Math.min(6, wrapperLevel + 1);
  return lines.map((line, index) => {
    const heading = headings.get(index);
    if (!heading) return line;
    const level = Math.min(6, firstChild + heading[1]!.length - minLevel);
    return `${"#".repeat(level)}${heading[2]}`;
  }).join("\n");
}

export function normalizeMarkdown(markdown: string): string {
  // Blank lines can be significant inside code and quoted code; preserve them.
  return markdown.replace(/\r\n?/g, "\n").trim();
}
