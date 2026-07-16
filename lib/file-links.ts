function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function normalizeFilePathSlashes(filePath: string): string {
  if (/^[a-zA-Z]:[\\/]/.test(filePath) || filePath.startsWith("\\\\")) {
    return filePath.replace(/\\/g, "/");
  }
  return filePath;
}

function inferHomeDirFromCwd(cwd?: string): string | null {
  if (!cwd) return null;
  const normalized = normalizeFilePathSlashes(cwd);
  const posixMatch = normalized.match(/^(\/home\/[^/]+|\/Users\/[^/]+)(?:\/|$)/);
  if (posixMatch) return posixMatch[1];
  const windowsMatch = normalized.match(/^([a-zA-Z]:\/Users\/[^/]+)(?:\/|$)/);
  if (windowsMatch) return windowsMatch[1];
  return null;
}

function expandHomePath(filePath: string, cwd?: string, homeDir?: string): string | null {
  if (filePath !== "~" && !filePath.startsWith("~/")) return filePath;
  const home = homeDir || inferHomeDirFromCwd(cwd);
  if (!home) return null;
  if (filePath === "~") return home;
  return `${normalizeFilePathSlashes(home).replace(/\/+$/, "")}/${filePath.slice(2)}`;
}

function stripLineSuffix(filePath: string): string {
  return filePath.replace(/:\d+(?::\d+)?$/, "");
}

function normalizeLocalPath(filePath: string): string {
  const normalized = normalizeFilePathSlashes(filePath);
  const isWindowsDrive = /^[a-zA-Z]:\//.test(normalized);
  const isUnc = normalized.startsWith("//");
  const leadingSlash = normalized.startsWith("/") && !isWindowsDrive && !isUnc;
  const parts: string[] = [];

  for (const part of normalized.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (parts.length > 0 && parts[parts.length - 1] !== "..") {
        parts.pop();
      } else if (!leadingSlash && !isWindowsDrive && !isUnc) {
        parts.push(part);
      }
      continue;
    }
    parts.push(part);
  }

  const joined = parts.join("/");
  if (isWindowsDrive) return joined;
  if (isUnc) return `//${joined}`;
  return leadingSlash ? `/${joined}` : joined;
}

function isPathInside(candidate: string, root: string): boolean {
  const normalizedCandidate = normalizeLocalPath(candidate).replace(/\/+$/, "");
  const normalizedRoot = normalizeLocalPath(root).replace(/\/+$/, "");
  const useCaseInsensitive = /^[a-zA-Z]:\//.test(normalizedCandidate) || /^[a-zA-Z]:\//.test(normalizedRoot);
  const filePath = useCaseInsensitive ? normalizedCandidate.toLowerCase() : normalizedCandidate;
  const rootPath = useCaseInsensitive ? normalizedRoot.toLowerCase() : normalizedRoot;
  return filePath === rootPath || filePath.startsWith(`${rootPath}/`);
}

function looksLikeRelativeFileHref(href: string): boolean {
  if (href.startsWith("#") || href.startsWith("?")) return false;
  if (href.startsWith("./") || href.startsWith("../")) return true;
  if (href.includes("/")) return true;
  return /(^|\/)\.?[^/]+\.[^/.]+$/.test(href);
}

function fileUrlToPath(href: string): string | null {
  try {
    const url = new URL(href);
    if (url.protocol !== "file:") return null;
    const pathname = safeDecode(url.pathname);
    if (url.hostname) {
      return `//${url.hostname}${pathname.startsWith("/") ? pathname : `/${pathname}`}`;
    }
    if (/^\/[a-zA-Z]:\//.test(pathname)) return pathname.slice(1);
    return pathname;
  } catch {
    return null;
  }
}

function isPathChar(ch: string): boolean {
  return /[A-Za-z0-9._~+%@/\\:-]/.test(ch);
}

function isReferenceStartBoundary(text: string, index: number): boolean {
  return index === 0 || !isPathChar(text[index - 1]);
}

function isReferenceEndBoundary(text: string, index: number): boolean {
  if (index >= text.length) return true;
  const ch = text[index];
  if (ch === ":") return /\d/.test(text[index + 1] ?? "");
  return !isPathChar(ch);
}

function isStopChar(ch: string): boolean {
  return /\s/.test(ch) || /[<>{}\[\]()"'`，。；！？、]/.test(ch);
}

function trimReferenceEnd(value: string): string {
  let end = value.length;
  while (end > 0) {
    const ch = value[end - 1];
    if (/[.,;!?，。；！？、]/.test(ch)) {
      end--;
      continue;
    }
    if (ch === ":" && !/\d/.test(value[end] ?? "")) {
      end--;
      continue;
    }
    break;
  }
  return value.slice(0, end);
}

function relativePathMatchAt(text: string, index: number): RegExpMatchArray | null {
  const match = text.slice(index).match(/^[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~+%@-]+)+\.[A-Za-z0-9]{1,16}(?::\d+(?::\d+)?)?/);
  if (!match) return null;
  return match;
}

function referenceStartLength(text: string, index: number): number {
  const rest = text.slice(index);
  if (rest.startsWith("file://")) return "file://".length;
  if (rest.startsWith("~/")) return 2;
  if (rest.startsWith("\\\\")) return 2;
  if (/^[a-zA-Z]:[\\/]/.test(rest)) return 3;
  if (rest.startsWith("./") || rest.startsWith("../")) return 2;
  if (rest.startsWith("/") && !rest.startsWith("//")) return 1;
  const relativeMatch = relativePathMatchAt(text, index);
  return relativeMatch ? relativeMatch[0].length : 0;
}

export type LocalFileReferencePart =
  | { type: "text"; value: string }
  | { type: "link"; value: string; href: string; filePath: string };

export function splitLocalFileReferences(text: string, cwd?: string, homeDir?: string): LocalFileReferencePart[] {
  const parts: LocalFileReferencePart[] = [];
  let cursor = 0;
  let index = 0;

  while (index < text.length) {
    if (!isReferenceStartBoundary(text, index)) {
      index++;
      continue;
    }

    const startLength = referenceStartLength(text, index);
    if (!startLength) {
      index++;
      continue;
    }

    let end = index + startLength;
    if (relativePathMatchAt(text, index)?.[0].length === startLength) {
      end = index + startLength;
    } else {
      while (end < text.length && !isStopChar(text[end])) end++;
    }

    const rawCandidate = trimReferenceEnd(text.slice(index, end));
    const candidateEnd = index + rawCandidate.length;
    const filePath = resolveLocalFileHref(rawCandidate, cwd, homeDir);
    if (!rawCandidate || !filePath || !isReferenceEndBoundary(text, candidateEnd)) {
      index = Math.max(index + 1, end);
      continue;
    }

    if (cursor < index) parts.push({ type: "text", value: text.slice(cursor, index) });
    parts.push({ type: "link", value: rawCandidate, href: rawCandidate, filePath });
    cursor = candidateEnd;
    index = candidateEnd;
  }

  if (cursor < text.length) parts.push({ type: "text", value: text.slice(cursor) });
  return parts.length ? parts : [{ type: "text", value: text }];
}

export function createLocalFileLinkRemarkPlugin(cwd?: string, homeDir?: string) {
  return function localFileLinkRemarkPlugin() {
    function visit(node: { type?: string; value?: string; children?: unknown[] }, parent?: { type?: string }): void {
      if (!node || typeof node !== "object") return;
      if (node.type === "text" && typeof node.value === "string" && parent?.type !== "link" && parent?.type !== "image") {
        const parts = splitLocalFileReferences(node.value, cwd, homeDir);
        if (parts.length > 1 || parts[0]?.type === "link") {
          const replacement = parts.map((part) => {
            if (part.type === "text") return { type: "text", value: part.value };
            return {
              type: "link",
              url: part.href,
              title: null,
              children: [{ type: "text", value: part.value }],
            };
          });
          Object.assign(node, { type: "paragraph", children: replacement });
          delete node.value;
          return;
        }
      }

      if (node.type === "link" || node.type === "image" || node.type === "definition" || node.type === "code" || node.type === "inlineCode") return;
      if (!Array.isArray(node.children)) return;

      for (let i = 0; i < node.children.length; i++) {
        const child = node.children[i] as { type?: string; value?: string; children?: unknown[] };
        if (child?.type === "text" && typeof child.value === "string") {
          const parts = splitLocalFileReferences(child.value, cwd, homeDir);
          if (parts.length > 1 || parts[0]?.type === "link") {
            node.children.splice(
              i,
              1,
              ...parts.map((part) => part.type === "text"
                ? { type: "text", value: part.value }
                : { type: "link", url: part.href, title: null, children: [{ type: "text", value: part.value }] }),
            );
            i += parts.length - 1;
            continue;
          }
        }
        visit(child, node);
      }
    }

    return (tree: { type?: string; children?: unknown[] }) => visit(tree);
  };
}

export function resolveLocalFileHref(href: string | undefined, cwd?: string, homeDir?: string): string | null {
  if (!href) return null;

  const cleanHref = href.split("#", 1)[0].split("?", 1)[0].trim();
  if (!cleanHref) return null;

  let candidate: string | null = null;
  let candidateKind: "absolute" | "relative" | null = null;
  const decodedHref = safeDecode(cleanHref);
  const isBackslashUncPath = decodedHref.startsWith("\\\\");
  const normalizedHref = normalizeFilePathSlashes(decodedHref);
  const lowerHref = normalizedHref.toLowerCase();

  if (lowerHref.startsWith("/api/") || lowerHref.startsWith("/_next/")) return null;
  if (!isBackslashUncPath && normalizedHref.startsWith("//")) return null;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/i.test(normalizedHref) && !lowerHref.startsWith("file:") && !/^[a-zA-Z]:\//.test(normalizedHref)) {
    return null;
  }

  if (lowerHref.startsWith("file:")) {
    candidate = fileUrlToPath(normalizedHref);
    candidateKind = candidate ? "absolute" : null;
  } else if (/^[a-zA-Z]:\//.test(normalizedHref)) {
    candidate = normalizedHref;
    candidateKind = "absolute";
  } else if (normalizedHref === "~" || normalizedHref.startsWith("~/")) {
    candidate = expandHomePath(normalizedHref, cwd, homeDir);
    candidateKind = candidate ? "absolute" : null;
  } else if (normalizedHref.startsWith("/")) {
    candidate = normalizedHref;
    candidateKind = "absolute";
  } else if (cwd && looksLikeRelativeFileHref(normalizedHref)) {
    candidate = `${normalizeFilePathSlashes(cwd).replace(/\/+$/, "")}/${normalizedHref}`;
    candidateKind = "relative";
  }

  if (!candidate) return null;

  const filePath = stripLineSuffix(normalizeLocalPath(candidate));
  if (candidateKind === "relative" && cwd && !isPathInside(filePath, cwd)) return null;
  return filePath;
}
