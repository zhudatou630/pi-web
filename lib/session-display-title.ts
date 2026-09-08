import { skillExpansionToCommand } from "./slash-display";

export const SESSION_FIRST_MESSAGE_PREVIEW_MAX_LENGTH = 500;

export interface SessionTitleSource {
  id: string;
  name?: string;
  firstMessage?: string;
}

function truncateText(text: string, maxLength: number): string {
  const truncated = text.slice(0, maxLength);
  const lastCodeUnit = truncated.charCodeAt(truncated.length - 1);
  return lastCodeUnit >= 0xD800 && lastCodeUnit <= 0xDBFF
    ? truncated.slice(0, -1)
    : truncated;
}

export function getSessionFirstMessagePreview(firstMessage: string | undefined): string {
  if (!firstMessage) return "";
  return truncateText(
    skillExpansionToCommand(firstMessage) ?? firstMessage,
    SESSION_FIRST_MESSAGE_PREVIEW_MAX_LENGTH,
  );
}

/** Sidebar title fallback: stored name, then a short first-message preview, then id. */
export function getSessionDisplayTitle(session: SessionTitleSource): string {
  if (session.name) return session.name;
  const preview = truncateText(getSessionFirstMessagePreview(session.firstMessage), 50);
  return preview || session.id.slice(0, 12);
}
