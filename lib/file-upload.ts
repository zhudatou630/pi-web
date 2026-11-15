import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";

export const UPLOAD_CONFLICT_STRATEGIES = ["error", "overwrite", "skip"] as const;
export type UploadConflictStrategy = typeof UPLOAD_CONFLICT_STRATEGIES[number];

const UPLOAD_CONFLICT_STRATEGY_SET = new Set<string>(UPLOAD_CONFLICT_STRATEGIES);

export interface UploadTargetInspection {
  conflicts: string[];
  nonReplaceable: string[];
}

export function parseUploadConflictStrategy(value: string | null): UploadConflictStrategy | null {
  const candidate = value ?? "error";
  return UPLOAD_CONFLICT_STRATEGY_SET.has(candidate)
    ? candidate as UploadConflictStrategy
    : null;
}

export function validateUploadFileNames(fileNames: string[]): string | null {
  if (fileNames.length === 0) return "No files selected";

  const seen = new Set<string>();
  for (const fileName of fileNames) {
    if (!fileName || fileName === "." || fileName === ".." || fileName.includes("\0")) {
      return `Invalid file name: ${fileName || "(empty)"}`;
    }
    if (fileName.includes("/") || fileName.includes("\\") || path.basename(fileName) !== fileName) {
      return `File names must not contain a path: ${fileName}`;
    }
    if (seen.has(fileName)) return `Duplicate file name in upload: ${fileName}`;
    seen.add(fileName);
  }

  return null;
}

export function inspectUploadTargets(directory: string, fileNames: string[]): UploadTargetInspection {
  const conflicts: string[] = [];
  const nonReplaceable: string[] = [];

  for (const fileName of fileNames) {
    const destination = path.join(directory, fileName);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(destination);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") continue;
      throw error;
    }

    conflicts.push(fileName);
    if (!stat.isFile() || stat.isSymbolicLink()) nonReplaceable.push(fileName);
  }

  return { conflicts, nonReplaceable };
}

function replaceableUploadStat(destination: string): fs.Stats {
  const stat = fs.lstatSync(destination);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("Cannot replace a directory or symbolic link");
  }
  return stat;
}

export async function writeUploadFile(destination: string, bytes: Buffer, overwrite: boolean): Promise<void> {
  if (!overwrite) {
    await fs.promises.writeFile(destination, bytes, { flag: "wx" });
    return;
  }

  const mode = replaceableUploadStat(destination).mode & 0o7777;
  const temporaryPath = path.join(
    path.dirname(destination),
    `.${path.basename(destination)}.pi-upload-${randomUUID()}`,
  );
  let temporaryFile;
  try {
    temporaryFile = await fs.promises.open(temporaryPath, "wx", mode);
    try {
      await temporaryFile.writeFile(bytes);
    } finally {
      await temporaryFile.close();
    }
    // No await between revalidation and rename: an async write may have yielded to another mutation.
    const currentMode = replaceableUploadStat(destination).mode & 0o7777;
    fs.chmodSync(temporaryPath, currentMode);
    fs.renameSync(temporaryPath, destination);
  } finally {
    if (temporaryFile && fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
  }
}
