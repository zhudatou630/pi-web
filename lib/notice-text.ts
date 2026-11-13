export interface NoticeTextPart {
  kind: "text" | "art";
  text: string;
}

// Block elements (█ ▀ ▄ ▌ ░ …): what terminal QR codes and bars are drawn with.
const BLOCK_ELEMENT_RE = /[▀-▟]/;

/**
 * Splits an extension notice into prose and the runs of lines drawn with block
 * characters, such as a `qrcode-terminal` QR code sent through `ctx.ui.notify()`
 * (#755). Those only line up on a terminal grid: every space kept, one monospace
 * font for spaces and blocks alike, no gap between rows. The toast's prose styling
 * collapses runs of spaces and spaces its lines apart. Joining the parts' text
 * gives back the message; the line breaks around a run stay in the prose.
 */
export function splitNoticeText(message: string): NoticeTextPart[] {
  const parts: NoticeTextPart[] = [];
  const push = (kind: NoticeTextPart["kind"], text: string) => {
    if (!text) return;
    const last = parts[parts.length - 1];
    if (last?.kind === kind) last.text += text;
    else parts.push({ kind, text });
  };

  let previousIsArt = false;
  message.split("\n").forEach((line, index) => {
    const isArt = BLOCK_ELEMENT_RE.test(line);
    if (index > 0) push(isArt && previousIsArt ? "art" : "text", "\n");
    push(isArt ? "art" : "text", line);
    previousIsArt = isArt;
  });
  return parts;
}

/** HTTP links in prose; punctuation is kept in the surrounding text, not the href. */
export function splitNoticeLinks(text: string): { kind: "text" | "link"; text: string }[] {
  const parts: { kind: "text" | "link"; text: string }[] = [];
  let end = 0;
  for (const match of text.matchAll(/https?:\/\/(?:\[[0-9a-f:.]+\])?[^\s<>"'`\]}。，、；：！？（）「」『』【】]*/gi)) {
    let url = match[0];
    let balance = 0;
    for (const char of url) {
      if (char === "(") balance++;
      if (char === ")") balance--;
    }
    let length = url.length;
    while (length > 0) {
      const char = url[length - 1];
      if (/[.,;:!?]/.test(char)) length--;
      else if (char === ")" && balance < 0) { length--; balance++; }
      else break;
    }
    url = url.slice(0, length);
    try { if (!new URL(url).host) continue; } catch { continue; }
    if (match.index > end) parts.push({ kind: "text", text: text.slice(end, match.index) });
    parts.push({ kind: "link", text: url });
    end = match.index + url.length;
  }
  if (end < text.length) parts.push({ kind: "text", text: text.slice(end) });
  return parts;
}
