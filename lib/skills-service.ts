import { DefaultResourceLoader, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { SkillInfo, SkillsResponse } from "@/lib/api-types";
import { annotateSkillsWithInstallInfo } from "@/lib/skill-lock";
import { getRemovableSkillEntry } from "@/lib/skill-delete";
import { getProjectTrustStatus, projectTrustReloadOptions } from "@/lib/project-trust";
import { resolveScopedResources } from "@/lib/project-resource-overrides";
import { realPathOrSelf as canonical } from "@/lib/worktree";

export async function loadSkillsWithInstallInfo(cwd: string): Promise<SkillsResponse> {
  const agentDir = getAgentDir();
  const loader = new DefaultResourceLoader({ cwd, agentDir });
  await loader.reload(projectTrustReloadOptions(cwd, agentDir));
  const { skills, diagnostics } = loader.getSkills();
  const scoped = (await resolveScopedResources(cwd, agentDir)).resources.filter((r) => r.type === "skills");
  const byPath = new Map(scoped.map((r) => [canonical(r.path), r]));
  return {
    skills: annotateSkillsWithInstallInfo(skills as SkillInfo[], { cwd, agentDir }).map((skill) => ({
      ...skill,
      removable: getRemovableSkillEntry(skill.filePath, cwd, agentDir) !== null,
      projectOverride: byPath.get(canonical(skill.filePath))?.override,
    })),
    diagnostics,
    projectResourcesLoaded: getProjectTrustStatus(cwd, agentDir).trusted,
  };
}
