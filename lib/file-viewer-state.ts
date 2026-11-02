import { getFileExt } from "./file-types";

export type FileViewerDisplayMode = "source" | "preview" | "diff";

export interface FileViewerState {
  displayMode: FileViewerDisplayMode;
  /** Set once the reader presses the wrap key; until then the file's kind decides (defaultWrapLines). */
  wrapLines?: boolean;
  scrollTop: number;
  scrollLeft: number;
  loadedBytes?: number;
  scrollByMode?: Partial<Record<FileViewerDisplayMode, {
    scrollTop: number;
    scrollLeft: number;
  }>>;
}

// Prose is read by sentences, so long lines wrap. Code and logs are read by their columns
// (indentation; a log's timestamp and level) and stay unwrapped.
const PROSE_EXTENSIONS = new Set(["md", "markdown", "mdx", "mdown", "mkd", "rst", "adoc", "txt"]);

export function defaultWrapLines(filePath: string): boolean {
  return PROSE_EXTENSIONS.has(getFileExt(filePath));
}

export function resolveInitialFileDisplayMode(
  initialState?: FileViewerState,
  initialDisplayMode?: FileViewerDisplayMode,
): FileViewerDisplayMode {
  return initialState?.displayMode ?? initialDisplayMode ?? "source";
}
