import { DefaultResourceLoader, getAgentDir, loadSkills } from "@earendil-works/pi-coding-agent";
import type { SkillInfo, SkillsResponse } from "@/lib/api-types";
import { annotateSkillsWithInstallInfo } from "@/lib/skill-lock";
import { getRemovableSkillEntry } from "@/lib/skill-delete";
import { getProjectTrustStatus, projectTrustReloadOptions } from "@/lib/project-trust";
import { resolveScopedResources } from "@/lib/project-resource-overrides";
import { realPathOrSelf as canonical } from "@/lib/worktree";

/**
 * Every skill configured for this cwd, loaded or not: the Skills page must still list a
 * skill that is switched off (globally or in this project) so it can be switched on again.
 * Loaded skills come from the runtime's loader (so extension-provided skills are included);
 * switched-off ones are parsed from their paths with the owner's source info.
 */
export async function loadSkillsWithInstallInfo(cwd: string): Promise<SkillsResponse> {
  const agentDir = getAgentDir();
  const loader = new DefaultResourceLoader({ cwd, agentDir });
  await loader.reload(projectTrustReloadOptions(cwd, agentDir));
  const { skills: loaded, diagnostics } = loader.getSkills();
  const scoped = (await resolveScopedResources(cwd, agentDir)).resources.filter((r) => r.type === "skills");
  const byPath = new Map(scoped.map((r) => [canonical(r.path), r]));
  const loadedPaths = new Set(loaded.map((skill) => canonical(skill.filePath)));
  const off = scoped.filter((r) => !loadedPaths.has(canonical(r.path)));
  const unloaded = off.length === 0 ? [] : loadSkills({
    cwd,
    agentDir,
    skillPaths: off.map((r) => r.path),
    includeDefaults: false,
  }).skills.map((skill) => {
    const owner = byPath.get(canonical(skill.filePath))?.owner;
    return owner ? { ...skill, sourceInfo: { ...skill.sourceInfo, ...owner, path: skill.filePath } } : skill;
  });
  const skills: SkillInfo[] = [...loaded, ...unloaded].map((skill) => {
    const scopedSkill = byPath.get(canonical(skill.filePath));
    return {
      ...skill,
      enabled: loadedPaths.has(canonical(skill.filePath)),
      globalEnabled: scopedSkill ? scopedSkill.globalEnabled : null,
      removable: getRemovableSkillEntry(skill.filePath, cwd, agentDir) !== null,
      projectOverride: scopedSkill?.override,
    };
  });
  return {
    skills: annotateSkillsWithInstallInfo(skills, { cwd, agentDir }),
    diagnostics,
    projectResourcesLoaded: getProjectTrustStatus(cwd, agentDir).trusted,
  };
}
