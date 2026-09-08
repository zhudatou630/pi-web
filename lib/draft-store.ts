import { MAX_ATTACHED_IMAGES } from "./image-attachments";

export interface ChatDraftImage {
  data: string;
  mimeType: string;
}

export interface ChatDraft {
  value: string;
  images: ChatDraftImage[];
}

const drafts = new Map<string, ChatDraft>();
const STORAGE_PREFIX = "pi-chat-draft:";

function storageKey(key: string): string {
  return `${STORAGE_PREFIX}${encodeURIComponent(key)}`;
}

function getStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

function readStoredDraft(key: string): ChatDraft | null {
  try {
    const raw = getStorage()?.getItem(storageKey(key));
    if (!raw) return null;
    const draft = JSON.parse(raw) as ChatDraft;
    if (typeof draft.value !== "string" || !Array.isArray(draft.images)) return null;
    if (!draft.images.every((image) => typeof image?.data === "string" && typeof image?.mimeType === "string")) return null;
    return cloneDraft(draft);
  } catch {
    return null;
  }
}

function cloneDraft(draft: ChatDraft): ChatDraft {
  return {
    value: draft.value,
    images: draft.images.map((image) => ({ ...image })),
  };
}

function isEmptyDraft(draft: ChatDraft): boolean {
  return !draft.value && draft.images.length === 0;
}

export function getDraft(key: string): ChatDraft | null {
  const draft = drafts.get(key) ?? readStoredDraft(key);
  if (draft && !drafts.has(key)) drafts.set(key, draft);
  return draft ? cloneDraft(draft) : null;
}

export function setDraft(key: string, draft: ChatDraft): boolean {
  if (isEmptyDraft(draft)) {
    clearDraft(key);
    return true;
  }
  const stored = cloneDraft(draft);
  drafts.set(key, stored);
  const storage = getStorage();
  if (!storage) return false;
  try {
    storage.setItem(storageKey(key), JSON.stringify(stored));
    return true;
  } catch {
    storage.removeItem(storageKey(key));
    return false;
  }
}

export function clearDraft(key: string): void {
  drafts.delete(key);
  try {
    getStorage()?.removeItem(storageKey(key));
  } catch {
    // Browser storage is optional.
  }
}

export function mergeRestoredSubmissionText(submitted: string, current: string): string {
  if (!submitted.trim()) return current;
  if (!current.trim()) return submitted;
  return `${submitted}\n\n${current}`;
}

export function exceedsAttachedImageSendLimit(count: number): boolean {
  return count > MAX_ATTACHED_IMAGES;
}

function toDraftImage(image: ChatDraftImage): ChatDraftImage {
  return { data: image.data, mimeType: image.mimeType };
}

export function mergeRestoredSubmissionDraft(
  submittedText: string,
  submittedImages: ChatDraftImage[] | undefined,
  currentText: string,
  currentImages: ChatDraftImage[],
): ChatDraft {
  return {
    value: mergeRestoredSubmissionText(submittedText, currentText),
    images: [...(submittedImages ?? []), ...currentImages].map(toDraftImage),
  };
}

export function restoreDraftSubmission(
  key: string,
  text: string,
  images?: ChatDraftImage[],
): ChatDraft {
  const current = getDraft(key) ?? { value: "", images: [] };
  const restored = mergeRestoredSubmissionDraft(
    text,
    images,
    current.value,
    current.images,
  );
  setDraft(key, restored);
  return restored;
}

export function rekeyDraft(
  previousKey: string,
  nextKey: string,
  currentDraft?: ChatDraft,
): ChatDraft | null {
  if (previousKey === nextKey) return currentDraft ? cloneDraft(currentDraft) : getDraft(nextKey);

  const storedPrevious = getDraft(previousKey);
  const previous = currentDraft && !isEmptyDraft(currentDraft)
    ? cloneDraft(currentDraft)
    : (storedPrevious ?? (currentDraft ? cloneDraft(currentDraft) : null));
  const next = getDraft(nextKey);
  clearDraft(previousKey);
  if (!previous) return next;

  const merged = next
    ? mergeRestoredSubmissionDraft(next.value, next.images, previous.value, previous.images)
    : previous;
  setDraft(nextKey, merged);
  return cloneDraft(merged);
}
