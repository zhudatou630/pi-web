// Browser-side file delivery shared by the export actions.

export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Revoking in the same task can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** Touch devices: blob downloads are unreliable there (iOS standalone PWAs), the share sheet is not. */
export function prefersShareSheet(): boolean {
  return matchMedia("(pointer: coarse)").matches && typeof navigator.canShare === "function";
}

/**
 * Opens the share sheet for one file. "unavailable" when the browser cannot share
 * it or the click's activation expired; callers then download instead.
 */
export async function shareFile(file: File): Promise<"shared" | "canceled" | "unavailable"> {
  if (!navigator.canShare?.({ files: [file] })) return "unavailable";
  try {
    await navigator.share({ files: [file] });
    return "shared";
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") return "canceled";
    return "unavailable";
  }
}
