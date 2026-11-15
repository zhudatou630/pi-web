import { readFileSync, realpathSync, statSync } from "fs";
import { relative, resolve } from "path";
import { isPathWithinRoots } from "./path-security";
import { toSlashPath } from "./paths";

export const MAX_SUBAGENT_INPUT_FILES = 8;
export const MAX_SUBAGENT_INPUT_BYTES = 512 * 1024;

/**
 * The files are inlined in the child's first message: at the flat limit (~131k tokens by pi's
 * chars/4) a 200k-window child could compact before its first tool call. Allow about a quarter of
 * its window, never more than the flat limit; an unknown window (0) keeps the flat limit.
 */
export function subagentInputByteLimit(model: { contextWindow?: number } | undefined): number {
  const contextWindow = model?.contextWindow;
  if (!contextWindow || contextWindow <= 0) return MAX_SUBAGENT_INPUT_BYTES;
  // A quarter of the window at ~4 bytes a token is one byte per window token.
  return Math.min(MAX_SUBAGENT_INPUT_BYTES, Math.floor(contextWindow));
}

export interface SubagentInputFile {
  path: string;
  content: string;
}

export function loadSubagentInputFiles(
  cwd: string,
  requestedPaths: readonly string[],
  maxBytes: number = MAX_SUBAGENT_INPUT_BYTES,
): SubagentInputFile[] {
  if (requestedPaths.length > MAX_SUBAGENT_INPUT_FILES) {
    throw new Error(`Agent input_files accepts at most ${MAX_SUBAGENT_INPUT_FILES} files`);
  }

  const realCwd = realpathSync(cwd);
  const allowedRoots = new Set([realCwd]);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const seen = new Set<string>();
  const files: SubagentInputFile[] = [];
  let totalBytes = 0;
  const limitMessage = `Agent input_files exceeds the ${maxBytes}-byte total limit for the subagent's model. `
    + "Pass fewer or smaller files, or name the paths in the prompt so the subagent reads what it needs.";

  for (const requestedPath of requestedPaths) {
    if (!requestedPath.trim()) throw new Error("Agent input_files paths must not be empty");

    let filePath: string;
    try {
      filePath = realpathSync(resolve(cwd, requestedPath));
    } catch {
      throw new Error(`Agent input file does not exist: ${requestedPath}`);
    }
    if (!isPathWithinRoots(filePath, allowedRoots)) {
      throw new Error(`Agent input file is outside the session cwd: ${requestedPath}`);
    }
    const stat = statSync(filePath);
    if (!stat.isFile()) {
      throw new Error(`Agent input path is not a file: ${requestedPath}`);
    }
    if (seen.has(filePath)) continue;
    seen.add(filePath);

    if (totalBytes + stat.size > maxBytes) throw new Error(limitMessage);
    const buffer = readFileSync(filePath);
    totalBytes += buffer.byteLength;
    if (totalBytes > maxBytes) {
      throw new Error(limitMessage);
    }

    let content: string;
    try {
      content = decoder.decode(buffer);
    } catch {
      throw new Error(`Agent input file is not valid UTF-8 text: ${requestedPath}`);
    }
    files.push({
      path: toSlashPath(relative(realCwd, filePath)),
      content,
    });
  }

  return files;
}

export function appendSubagentInputFiles(task: string, files: readonly SubagentInputFile[]): string {
  if (files.length === 0) return task;
  const documents = files.map((file) =>
    `<document path=${JSON.stringify(file.path)}>\n${file.content}\n</document>`
  ).join("\n\n");
  return `${task}\n\n<documents>\n${documents}\n</documents>`;
}
