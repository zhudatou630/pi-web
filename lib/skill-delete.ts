import { lstatSync, rmSync, unlinkSync } from "fs";
import { homedir } from "os";
import { basename, dirname, join } from "path";
import { samePath } from "./paths";

/**
 * The filesystem entry pi discovered for a skill: the skill directory for
 * `<root>/<name>/SKILL.md`, or the file itself for `<root>/<name>.md`.
 * Returns null unless that entry sits directly in an auto-discovered skills
 * root (`~/.pi/agent/skills`, `<cwd>/.pi/skills`, any `.agents/skills`).
 * Package and settings-path skills live elsewhere and are owned by their
 * package or the user's config, so they are never deletable here.
 */
export function getRemovableSkillEntry(filePath: string, cwd: string, agentDir: string): string | null {
  const entry = basename(filePath) === "SKILL.md" ? dirname(filePath) : filePath;
  const root = dirname(entry);
  const isRoot =
    samePath(root, join(agentDir, "skills")) ||
    samePath(root, join(cwd, ".pi", "skills")) ||
    samePath(root, join(homedir(), ".agents", "skills")) ||
    (basename(root) === "skills" && basename(dirname(root)) === ".agents");
  return isRoot ? entry : null;
}

/** Removes the entry itself; a symlinked skill only loses its link, never the shared target. */
export function removeSkillEntry(entry: string): void {
  if (lstatSync(entry).isSymbolicLink()) unlinkSync(entry);
  else rmSync(entry, { recursive: true });
}
