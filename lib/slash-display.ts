/**
 * Display-only restoration for the exact envelope emitted by pi's
 * `_expandSkillCommand`. The expanded text remains the stored session input.
 */
const SKILL_EXPANSION_RE = /^<skill name="([^"\n]+)" location="([^"\n]+)">\n(References are relative to [^\n]+\.\n\n[\s\S]*)\n<\/skill>(?:\n\n([\s\S]+))?$/;

/**
 * Restore a complete SDK skill expansion to its compact command form.
 *
 * The expression intentionally requires the opening envelope, matching
 * base-directory reference, final closing tag, and an optional two-newline args
 * suffix. This avoids collapsing ordinary text that merely starts with a
 * skill-looking tag. The greedy body capture makes the final closing tag win
 * when a skill body contains an example `</skill>` tag.
 */
export function skillExpansionToCommand(text: string): string | null {
  const match = text.match(SKILL_EXPANSION_RE);
  if (!match) return null;

  const [, name, , , args] = match;
  return args ? `/skill:${name} ${args}` : `/skill:${name}`;
}

/** Expanded display excludes the SDK envelope and the separately shown arguments. */
export function skillExpansionBody(text: string): string | null {
  return text.match(SKILL_EXPANSION_RE)?.[3] ?? null;
}
