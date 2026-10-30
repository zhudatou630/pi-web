import { randomUUID } from "crypto";
import { chmodSync, lstatSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "fs";
import { basename, dirname, join } from "path";

/**
 * Replace a file atomically without exposing credentials through default
 * process permissions. The caller must create the parent directory first.
 * Follow file symlinks only for user config, never for unchecked project paths.
 */
export function writePrivateFileAtomicSync(
  path: string, contents: string | Buffer, mode = 0o600,
  options: { followSymlinks?: boolean } = {},
): void {
  if (options.followSymlinks) {
    let isLink = false;
    try { isLink = lstatSync(path).isSymbolicLink(); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (isLink) {
      try { path = realpathSync(path); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          throw new Error(`Refusing to overwrite dangling symlink: ${path}`, { cause: error });
        }
        throw error;
      }
    }
  }
  const dir = dirname(path);
  const tempPath = join(dir, `.${basename(path)}-${randomUUID()}.tmp`);
  let operationFailed = false;

  try {
    writeFileSync(tempPath, contents, {
      ...(typeof contents === "string" ? { encoding: "utf8" as const } : {}),
      flag: "wx",
      mode,
      flush: true,
    });
    chmodSync(tempPath, mode);
    renameSync(tempPath, path);
  } catch (error) {
    operationFailed = true;
    throw error;
  } finally {
    try {
      unlinkSync(tempPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !operationFailed) {
        throw error;
      }
    }
  }
}
