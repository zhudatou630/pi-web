import { normalizeFilePathSlashes } from "./file-paths";
import type { GitFileStatus } from "./git-types";

/**
 * The Changes view's "only this turn's files" scope: the uncommitted list filtered to the files the
 * last turn wrote. The numbers stay each file's whole uncommitted diff (git has no per-turn counts).
 * `omitted`: files the turn wrote inside `cwd` that have no uncommitted change (committed, reverted).
 */
export function turnScopedChanges(files: readonly GitFileStatus[], turnFiles: readonly string[], cwd: string) {
  const turn = new Set(turnFiles.map(normalizeFilePathSlashes));
  // In the order the turn wrote them, like the turn's card.
  const order = [...turn];
  const listed = files.filter((file) => turn.has(normalizeFilePathSlashes(file.filePath)))
    .sort((a, b) => order.indexOf(normalizeFilePathSlashes(a.filePath)) - order.indexOf(normalizeFilePathSlashes(b.filePath)));
  const root = normalizeFilePathSlashes(cwd).replace(/\/+$/, "");
  const inCwd = order.filter((filePath) => filePath.startsWith(`${root}/`)).length;
  return { files: listed, omitted: Math.max(0, inCwd - listed.length) };
}
