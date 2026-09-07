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
};

export type SessionMarkdownExportResult =
  | { ok: true; markdown: string; fileName: string; title: string; turns: number }
  | { ok: false; error: "empty" };

type DialogueRound = {
  title: string;
  question: string;
  questionImages: number;
  answer: string;
  answerImages: number;
};

const TITLE_LIMIT = 44;
const FILE_STEM_LIMIT = 60;

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
  const title = options.title?.trim()
    || sessionNameFromEntries(entries)
    || rounds[0]!.title
    || "session";
  const model = lastModelOf(branch);
  const timestamp = exportedAt.toISOString().replace(/\.\d{3}Z$/, "Z");
  const meta = [
    timestamp,
    model,
    `${rounds.length} turn${rounds.length === 1 ? "" : "s"}`,
  ].filter(Boolean).join(" · ");

  const sections = rounds.map((round, index) => renderRound(round, index + 1));
  const markdown = normalizeMarkdown([
    `# ${title}`,
    "",
    meta,
    "",
    sections.join("\n\n"),
  ].join("\n")) + "\n";

  const date = exportedAt.toISOString().slice(0, 10);
  return {
    ok: true,
    markdown,
    fileName: `${date}_${sanitizeExportFileName(title)}.md`,
    title,
    turns: rounds.length,
  };
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
      const extracted = extractTextAndImages(entry.message?.content);
      current = {
        title: dialogueTitle(extracted.text, extracted.imageCount),
        question: extracted.text,
        questionImages: extracted.imageCount,
        answer: "",
        answerImages: 0,
      };
      rounds.push(current);
      continue;
    }
    if (role !== "assistant" || !current) continue;
    const extracted = extractTextAndImages(entry.message?.content);
    if (!extracted.text.trim() && extracted.imageCount === 0) continue;
    current.answer = current.answer
      ? `${current.answer}\n\n${extracted.text}`
      : extracted.text;
    current.answerImages += extracted.imageCount;
  }

  return rounds.filter((round) => round.answer.trim() || round.answerImages > 0);
}

function extractTextAndImages(content: unknown): { text: string; imageCount: number } {
  if (typeof content === "string") return { text: content, imageCount: 0 };
  if (!Array.isArray(content)) return { text: "", imageCount: 0 };

  const texts: string[] = [];
  let imageCount = 0;
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const type = "type" in block ? block.type : undefined;
    if (type === "text" && "text" in block && typeof block.text === "string") {
      texts.push(block.text);
    } else if (type === "image") {
      imageCount += 1;
    }
  }
  return { text: texts.join("\n"), imageCount };
}

function dialogueTitle(markdown: string, imageCount: number): string {
  for (const line of normalizeMarkdown(markdown).split("\n")) {
    if (!line.trim() || /^\s*(`{3,}|~{3,})/.test(line)) continue;
    let title = line.replace(/^\s*#{1,6}\s*/, "").replace(/^\s*[-*>]\s*/, "");
    title = title.replace(/[`*_]/g, "").replace(/\s+/g, " ").trim();
    if (!title) continue;
    return title.length > TITLE_LIMIT ? `${title.slice(0, TITLE_LIMIT)}…` : title;
  }
  return imageCount > 0 ? "image" : "Untitled";
}

function renderRound(round: DialogueRound, index: number): string {
  const heading = `## ${index}. ${round.title}`;
  const question = withPlaceholders(round.question, round.questionImages);
  const answer = withPlaceholders(round.answer, round.answerImages);
  const lines = [heading, ""];
  if (question && question !== round.title) {
    lines.push(rebaseHeadings(question, 2), "");
  }
  lines.push(rebaseHeadings(answer, 2));
  return lines.join("\n");
}

function withPlaceholders(text: string, imageCount: number): string {
  if (imageCount <= 0) return text;
  const marks = Array.from({ length: imageCount }, () => MARKDOWN_IMAGE_PLACEHOLDER).join("\n");
  return text.trim() ? `${text}\n\n${marks}` : marks;
}

export function rebaseHeadings(markdown: string, wrapperLevel = 2): string {
  const lines = normalizeMarkdown(markdown).split("\n");
  const fenceRe = /^\s*(`{3,}|~{3,})/;
  let minLevel = 7;
  let inFence = false;
  let fenceChar: string | undefined;

  for (const line of lines) {
    const fence = fenceRe.exec(line);
    if (fence) {
      const character = fence[1]![0]!;
      if (!inFence) {
        inFence = true;
        fenceChar = character;
      } else if (character === fenceChar) {
        inFence = false;
        fenceChar = undefined;
      }
      continue;
    }
    if (inFence) continue;
    const heading = /^(#{1,6})(\s+.*)$/.exec(line);
    if (heading) minLevel = Math.min(minLevel, heading[1]!.length);
  }
  if (minLevel === 7) return markdown;

  const firstChild = Math.min(6, wrapperLevel + 1);
  const out: string[] = [];
  inFence = false;
  fenceChar = undefined;
  for (const line of lines) {
    const fence = fenceRe.exec(line);
    if (fence) {
      const character = fence[1]![0]!;
      if (!inFence) {
        inFence = true;
        fenceChar = character;
      } else if (character === fenceChar) {
        inFence = false;
        fenceChar = undefined;
      }
      out.push(line);
      continue;
    }
    if (inFence) {
      out.push(line);
      continue;
    }
    const heading = /^(#{1,6})(\s+.*)$/.exec(line);
    if (!heading) {
      out.push(line);
      continue;
    }
    const level = Math.min(6, firstChild + heading[1]!.length - minLevel);
    out.push(`${"#".repeat(level)}${heading[2]}`);
  }
  return out.join("\n");
}

export function normalizeMarkdown(markdown: string): string {
  return markdown.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}
