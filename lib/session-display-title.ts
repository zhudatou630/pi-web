import { skillExpansionToCommand } from "./slash-display";

export interface SessionTitleSource {
  id: string;
  name?: string;
  firstMessage?: string;
}

function collapsedFirstMessage(firstMessage: string | undefined): string {
  if (!firstMessage) return "";
  return skillExpansionToCommand(firstMessage) ?? firstMessage;
}

/** Sidebar title fallback: stored name, then a short first-message preview, then id. */
export function getSessionDisplayTitle(session: SessionTitleSource): string {
  if (session.name) return session.name;
  const preview = collapsedFirstMessage(session.firstMessage).slice(0, 50);
  return preview || session.id.slice(0, 12);
}
