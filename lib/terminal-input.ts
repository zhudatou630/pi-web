export interface TerminalKeyEventLike {
  key: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}

const SPECIAL_KEY_SEQUENCES: Record<string, string> = {
  ArrowUp: "\x1b[A",
  ArrowDown: "\x1b[B",
  ArrowRight: "\x1b[C",
  ArrowLeft: "\x1b[D",
  Home: "\x1b[H",
  End: "\x1b[F",
  Insert: "\x1b[2~",
  Delete: "\x1b[3~",
  PageUp: "\x1b[5~",
  PageDown: "\x1b[6~",
  Escape: "\x1b",
  Backspace: "\x7f",
};

function legacyCtrlSequence(key: string): string | null {
  if (key === " ") return "\x00";
  if (key === "/" || key === "-") return "\x1f";
  if (key.length !== 1) return null;
  const code = key.toUpperCase().charCodeAt(0);
  if (code >= 64 && code <= 95) return String.fromCharCode(code & 0x1f);
  if (key === "?") return "\x7f";
  return null;
}

export function toTerminalKeyData(event: TerminalKeyEventLike): string | null {
  if (event.metaKey) return null;
  if (event.ctrlKey && !event.altKey && event.key.toLowerCase() === "v") return null;

  if (event.ctrlKey && !event.altKey) {
    const control = legacyCtrlSequence(event.key);
    if (control) return control;
  }

  const special = Object.hasOwn(SPECIAL_KEY_SEQUENCES, event.key) ? SPECIAL_KEY_SEQUENCES[event.key] : null;
  const modifier = 1 + Number(event.shiftKey) + 2 * Number(event.altKey) + 4 * Number(event.ctrlKey);
  if (modifier > 1 && special?.startsWith("\x1b[")) {
    return special.endsWith("~")
      ? `${special.slice(0, -1)};${modifier}~`
      : `\x1b[1;${modifier}${special.slice(-1)}`;
  }

  if (event.altKey && !event.ctrlKey) {
    if (event.key === "Backspace") return "\x1b\x7f";
    if (event.key.length === 1) return `\x1b${event.key}`;
  }

  if (event.key === "Enter") return event.shiftKey ? "\n" : "\r";
  if (event.key === "Tab") return event.shiftKey ? "\x1b[Z" : "\t";

  return special;
}

export function asBracketedPaste(text: string): string {
  return `\x1b[200~${text}\x1b[201~`;
}
