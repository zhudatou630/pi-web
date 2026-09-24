export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

// Same order as pi-ai's EXTENDED_THINKING_LEVELS.
export const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

// Mirrors pi-ai's clampThinkingLevel: nearest supported level, scanning upward
// first. "auto" is a UI-only value (pi decides), so it passes through.
export function clampThinkingLevelTo(available: string[] | undefined, level: string): string {
  if (!available?.length || available.includes(level) || level === "auto") return level;
  const start = THINKING_LEVELS.indexOf(level as ThinkingLevel);
  if (start === -1) return available[0];
  for (let i = start + 1; i < THINKING_LEVELS.length; i++) {
    if (available.includes(THINKING_LEVELS[i])) return THINKING_LEVELS[i];
  }
  for (let i = start - 1; i >= 0; i--) {
    if (available.includes(THINKING_LEVELS[i])) return THINKING_LEVELS[i];
  }
  return available[0];
}
