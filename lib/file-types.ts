export const TEXT_PREVIEW_MAX_BYTES = 256 * 1024;
export const IMAGE_PREVIEW_MAX_BYTES = 10 * 1024 * 1024;
export const DOCX_PREVIEW_MAX_BYTES = 10 * 1024 * 1024;

/** /api/files read error for files that are not text (NUL byte in the first chunk, as git decides). */
export const BINARY_FILE_ERROR = "Binary file, preview not available";

export type DocumentPreviewKind = "pdf" | "docx";

export const IMAGE_EXT_TO_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  ico: "image/x-icon",
  avif: "image/avif",
};

export const AUDIO_EXT_TO_MIME: Record<string, string> = {
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  opus: "audio/ogg",
  m4a: "audio/mp4",
  aac: "audio/aac",
  flac: "audio/flac",
  weba: "audio/webm",
};

export const VIDEO_EXT_TO_MIME: Record<string, string> = {
  mp4: "video/mp4",
  m4v: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  ogv: "video/ogg",
};

export const DOCUMENT_EXT_TO_MIME: Record<DocumentPreviewKind, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

// HTML/Markdown enable Preview; component templates must use markup instead.
// `.m` stays plain because Objective-C and MATLAB share the extension.
const EXT_TO_LANGUAGE: Record<string, string> = {
  ts: "typescript", tsx: "tsx", mts: "typescript", cts: "typescript",
  js: "javascript", jsx: "jsx", mjs: "javascript", cjs: "javascript",
  py: "python", rb: "ruby", php: "php", lua: "lua", pl: "perl", r: "r",
  go: "go", rs: "rust", java: "java", kt: "kotlin", kts: "kotlin", swift: "swift",
  scala: "scala", groovy: "groovy", gradle: "groovy", dart: "dart", zig: "zig",
  c: "c", cpp: "cpp", h: "c", hpp: "cpp", cs: "csharp", mm: "objectivec",
  ex: "elixir", exs: "elixir", hs: "haskell", ml: "ocaml", clj: "clojure", nix: "nix",
  html: "html", htm: "html", vue: "markup", svelte: "markup", astro: "markup",
  css: "css", scss: "scss", less: "less",
  json: "json", jsonl: "json", yaml: "yaml", yml: "yaml",
  // shortcut: generic .conf files use INI; add format detection if non-INI configs need it.
  toml: "toml", ini: "ini", cfg: "ini", conf: "ini", properties: "properties",
  xml: "xml", md: "markdown", mdx: "markdown", markdown: "markdown", tex: "latex",
  sh: "bash", bash: "bash", zsh: "bash", fish: "bash",
  ps1: "powershell", psm1: "powershell", bat: "batch", cmd: "batch",
  sql: "sql", graphql: "graphql", gql: "graphql", proto: "protobuf",
  dockerfile: "dockerfile", tf: "hcl", hcl: "hcl", diff: "diff", patch: "diff",
  env: "bash", gitignore: "bash", txt: "text",
  pdf: "pdf", docx: "word",
};

/** Shared by the reader and diffs, including deleted files with no readable content. */
export function getFileLanguage(filePath: string): string {
  const base = getBaseName(filePath).toLowerCase();
  if (base === "dockerfile" || base.startsWith("dockerfile.")) return "dockerfile";
  if (base === ".env" || base.startsWith(".env.")) return "bash";
  if (base === "makefile" || base === "gnumakefile") return "makefile";
  const ext = base.split(".").pop() ?? "";
  return EXT_TO_LANGUAGE[ext] ?? "text";
}

function getBaseName(filePath: string): string {
  return filePath.replace(/\\/g, "/").split("/").pop() ?? "";
}

export function getFileExt(filePath: string): string {
  return getBaseName(filePath).toLowerCase().split(".").pop() ?? "";
}

export function getImageMime(filePath: string): string | null {
  return IMAGE_EXT_TO_MIME[getFileExt(filePath)] ?? null;
}

export function getAudioMime(filePath: string): string | null {
  return AUDIO_EXT_TO_MIME[getFileExt(filePath)] ?? null;
}

export function getVideoMime(filePath: string): string | null {
  return VIDEO_EXT_TO_MIME[getFileExt(filePath)] ?? null;
}

export function getDocumentMime(filePath: string): string | null {
  return DOCUMENT_EXT_TO_MIME[getFileExt(filePath) as DocumentPreviewKind] ?? null;
}

export function documentPreviewKind(filePath: string): DocumentPreviewKind | null {
  const ext = getFileExt(filePath);
  if (ext === "pdf" || ext === "docx") return ext;
  return null;
}

export function isImagePath(filePath: string): boolean {
  return getImageMime(filePath) !== null;
}

export function isAudioPath(filePath: string): boolean {
  return getAudioMime(filePath) !== null;
}

export function isVideoPath(filePath: string): boolean {
  return getVideoMime(filePath) !== null;
}

export function isDocumentPreviewPath(filePath: string): boolean {
  return documentPreviewKind(filePath) !== null;
}

const FILE_PREVIEW_EXTENSIONS = new Set(["md", "mdx", "markdown", "html", "htm"]);

export function isFilePreviewPath(filePath: string): boolean {
  return FILE_PREVIEW_EXTENSIONS.has(getFileExt(filePath));
}
