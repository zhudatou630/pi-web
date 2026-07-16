import type { SessionEntry } from "./types";

const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidSessionId(sessionId: string | null): sessionId is string {
  return !!sessionId && SESSION_ID_RE.test(sessionId);
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function normalizeSlashes(value: string): string {
  return value.replace(/\\/g, "/");
}

function isPathInside(candidate: string, root: string): boolean {
  const normalizedCandidate = normalizeSlashes(candidate).replace(/\/+$/, "");
  const normalizedRoot = normalizeSlashes(root).replace(/\/+$/, "");
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}/`);
}

function isPathChar(ch: string): boolean {
  return /[A-Za-z0-9._~+%@/\\:-]/.test(ch);
}

function hasReferenceBoundaryAfter(text: string, index: number): boolean {
  if (index >= text.length) return true;
  const ch = text[index];
  if (ch === ":") return /\d/.test(text[index + 1] ?? "");
  return !isPathChar(ch);
}

function getReferenceTargets(filePath: string, homeDir?: string): string[] {
  const target = normalizeSlashes(filePath);
  const targets = target.startsWith("/") ? [target, `file://${target}`] : [target];

  if (homeDir && isPathInside(target, homeDir)) {
    const home = normalizeSlashes(homeDir).replace(/\/+$/, "");
    const suffix = target.slice(home.length);
    targets.push(`~${suffix}`);
  }

  return targets;
}

function containsExactPathReference(text: string, filePath: string, homeDir?: string): boolean {
  const targets = getReferenceTargets(filePath, homeDir);
  const haystacks = new Set([normalizeSlashes(text), normalizeSlashes(safeDecode(text))]);

  for (const haystack of haystacks) {
    for (const t of targets) {
      let index = haystack.indexOf(t);
      while (index !== -1) {
        const before = index === 0 ? "" : haystack[index - 1];
        const afterIndex = index + t.length;
        if ((index === 0 || !isPathChar(before)) && hasReferenceBoundaryAfter(haystack, afterIndex)) {
          return true;
        }
        index = haystack.indexOf(t, index + 1);
      }
    }
  }

  return false;
}

function collectStrings(value: unknown, out: string[]): void {
  if (typeof value === "string") {
    out.push(value);
    return;
  }
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out);
    return;
  }
  for (const item of Object.values(value)) collectStrings(item, out);
}

export function isFilePathReferencedByEntries(filePath: string, entries: SessionEntry[], homeDir?: string): boolean {
  for (const entry of entries) {
    const strings: string[] = [];
    collectStrings(entry, strings);
    if (strings.some((text) => containsExactPathReference(text, filePath, homeDir))) return true;
  }
  return false;
}
