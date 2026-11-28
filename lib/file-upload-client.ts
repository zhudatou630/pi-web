import { buildAtMentionText } from "./file-fuzzy";
import { encodeFilePathForApi } from "./file-paths";

export interface UploadFile { file: File; path: string }

export function checkUploadSize(files: UploadFile[]): void {
  if (files.reduce((size, { file }) => size + file.size, 0) > 100 * 1024 * 1024) {
    throw new Error("Uploads must total 100MB or less");
  }
}

export function pickedUploadFiles(files: File[]): UploadFile[] {
  return files.flatMap((file) => {
    const relative = file.webkitRelativePath;
    if (relative && relative.split("/").slice(1).some((name) => name.startsWith("."))) return [];
    return [{ file, path: relative || file.name }];
  });
}

/** Top-level files and folders (the latter carry a trailing slash for mentions). */
export function uploadTopEntries(paths: string[]): string[] {
  return [...new Set(paths.map((relative) => relative.match(/^[^/]+\//)?.[0] ?? relative))];
}

/** Browser side of `POST /api/files/[...path]?type=upload`; mirrors `lib/file-upload.ts`. */
export type UploadConflictStrategy = "error" | "overwrite" | "skip";

export interface UploadError {
  name: string;
  error: string;
}

export interface UploadResponse {
  uploaded?: string[];
  skipped?: string[];
  errors?: UploadError[];
  conflicts?: string[];
  nonReplaceable?: string[];
  error?: string;
}

/**
 * Uploads files into one directory through the file API.
 * @param targetDirectory The directory the files are written to
 * @param files The files and their destination-relative paths
 * @param strategy What the server does with a name that already exists
 * @param onProgress Upload progress in percent, when the browser reports it
 * @returns The HTTP status and the parsed response body
 */
export function uploadFiles(
  targetDirectory: string,
  files: UploadFile[],
  strategy: UploadConflictStrategy,
  onProgress?: (progress: number) => void,
): Promise<{ status: number; data: UploadResponse }> {
  return new Promise((resolve, reject) => {
    const formData = new FormData();
    checkUploadSize(files);
    for (const { file, path } of files) {
      formData.append("files", file, file.name);
      formData.append("paths", path);
    }

    const xhr = new XMLHttpRequest();
    xhr.open(
      "POST",
      `/api/files/${encodeFilePathForApi(targetDirectory)}?type=upload&conflict=${strategy}`,
    );
    xhr.upload.onprogress = (event) => {
      if (onProgress && event.lengthComputable && event.total > 0) {
        onProgress(Math.round((event.loaded / event.total) * 100));
      }
    };
    xhr.onerror = () => reject(new Error("Network error while uploading files"));
    xhr.onabort = () => reject(new Error("Upload cancelled"));
    xhr.onload = () => {
      let data: UploadResponse = {};
      try {
        data = JSON.parse(xhr.responseText) as UploadResponse;
      } catch {
        if (xhr.responseText) data.error = xhr.responseText;
      }
      resolve({ status: xhr.status, data });
    };
    xhr.send(formData);
  });
}

export type DroppedItem = { kind: "file"; file: File } | { kind: "folder"; entry: FileSystemDirectoryEntry };

async function readFolder(entry: FileSystemDirectoryEntry, prefix: string, files: UploadFile[]): Promise<void> {
  const reader = entry.createReader();
  // Chromium reads at most 100 entries per batch.
  for (;;) {
    const children = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
    if (!children.length) return;
    for (const child of children) {
      if (child.name.startsWith(".")) continue;
      const path = prefix + child.name;
      if (child.isDirectory) await readFolder(child as FileSystemDirectoryEntry, path + "/", files);
      else if (child.isFile) {
        const file = await new Promise<File>((resolve, reject) => (child as FileSystemFileEntry).file(resolve, reject));
        files.push({ file, path });
      }
    }
  }
}

/**
 * Only loose images attach to the prompt; images in folders are uploaded with their siblings.
 * A folder that cannot be read is left out whole (named in `failedFolders`); the other items still go.
 */
export async function splitDroppedItems(items: DroppedItem[], attachImages = true): Promise<{ images: File[]; files: UploadFile[]; failedFolders: string[] }> {
  const images: File[] = [];
  const files: UploadFile[] = [];
  const failedFolders: string[] = [];
  for (const item of items) {
    if (item.kind === "folder") {
      const folderFiles: UploadFile[] = [];
      try {
        await readFolder(item.entry, item.entry.name + "/", folderFiles);
        files.push(...folderFiles);
      } catch {
        failedFolders.push(item.entry.name);
      }
    } else if (attachImages && item.file.type.startsWith("image/")) images.push(item.file);
    else files.push({ file: item.file, path: item.file.name });
  }
  return { images, files, failedFolders };
}

export function dropMentionText(files: UploadFile[], present: string[]): string {
  const names = new Set(present);
  return uploadTopEntries(files.map(({ path }) => path).filter((path) => names.has(path)))
    .map((entry) => buildAtMentionText(entry, false)).join("");
}

/**
 * Reads a drop's files and folders. `webkitGetAsEntry()` only answers during
 * the drop event, so this has to run inside the handler. A folder is told by
 * its entry first: some browsers return no `File` for it.
 */
export function droppedItems(dataTransfer: DataTransfer): DroppedItem[] {
  const items: DroppedItem[] = [];
  for (const item of Array.from(dataTransfer.items)) {
    if (item.kind !== "file") continue;
    const entry = item.webkitGetAsEntry?.();
    if (entry?.isDirectory) {
      items.push({ kind: "folder", entry: entry as FileSystemDirectoryEntry });
      continue;
    }
    const file = item.getAsFile();
    if (file) items.push({ kind: "file", file });
  }
  if (items.length > 0) return items;
  return Array.from(dataTransfer.files).map((file) => ({ kind: "file", file }));
}
