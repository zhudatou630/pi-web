import { NextResponse } from "next/server";
import { lstatSync, readFileSync, writeFileSync } from "fs";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { runNpx } from "@/lib/npx";
import { getRemovableSkillEntry, removeSkillEntry } from "@/lib/skill-delete";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { loadSkillsWithInstallInfo } from "@/lib/skills-service";
import { setDisableModelInvocation } from "@/lib/skill-frontmatter";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";

export const dynamic = "force-dynamic";

// GET /api/skills?cwd=<path>
// Uses DefaultResourceLoader (same logic as AgentSession startup) so settings.json
// skill paths, package skills, and .agents/skills directories are all included.
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const cwd = searchParams.get("cwd");
  if (!cwd) return NextResponse.json({ error: "cwd required" }, { status: 400 });

  try {
    const allowedRoots = await getAllowedFileRoots();
    if (!isExistingFilePathAllowed(cwd, allowedRoots)) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }
    return NextResponse.json(await loadSkillsWithInstallInfo(cwd));
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

function entryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

// DELETE /api/skills — remove a skill that lives directly in an auto-discovered
// skills directory. skills.sh installs go through `skills remove` so its lock
// file and canonical copy are cleaned too; other entries are deleted in place
// (symlinks are unlinked, never followed). Package and settings-path skills are
// refused: they belong to their package or to the user's settings.
export async function DELETE(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }
  try {
    const { cwd, filePath } = await req.json() as { cwd?: string; filePath?: string };
    if (!cwd || !filePath) return NextResponse.json({ error: "cwd and filePath required" }, { status: 400 });

    const allowedRoots = await getAllowedFileRoots();
    if (!isExistingFilePathAllowed(cwd, allowedRoots)) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }
    const { skills } = await loadSkillsWithInstallInfo(cwd);
    const skill = skills.find((item) => item.filePath === filePath);
    if (!skill) return NextResponse.json({ error: "Access denied" }, { status: 403 });

    const entry = getRemovableSkillEntry(filePath, cwd, getAgentDir());
    if (!entry) {
      return NextResponse.json({ error: "This skill is managed by a package or settings path" }, { status: 409 });
    }

    let output = "";
    if (skill.install) {
      const args = ["skills", "remove", skill.name, "-y"];
      if (skill.install.scope === "global") args.push("-g");
      const { stdout, stderr } = await runNpx(args, {
        timeout: 60_000,
        cwd: skill.install.scope === "project" ? cwd : undefined,
        env: { ...process.env, FORCE_COLOR: "0" },
      });
      output = `${stdout}${stderr}`;
      if (entryExists(entry)) {
        return NextResponse.json({ error: output.slice(-300) || "skills remove left the skill in place" }, { status: 500 });
      }
    } else {
      removeSkillEntry(entry);
    }
    return NextResponse.json({ success: true, output: output.slice(-500) });
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    const output = `${err.stdout ?? ""}${err.stderr ?? ""}`;
    return NextResponse.json({ error: output || err.message || String(e) }, { status: 500 });
  }
}

// PATCH /api/skills — toggle disable-model-invocation on a SKILL.md file.
// Authorize by cwd (same as GET) plus exact filePath membership in the skills
// that cwd already loaded. Do not add install-cache directories to the file
// allow-list: a loaded skill may be a symlink whose realpath lives anywhere.
export async function PATCH(req: Request) {
  try {
    const body = await req.json() as { cwd: string; filePath: string; disableModelInvocation: boolean };
    const { cwd, filePath, disableModelInvocation } = body;
    if (!cwd) return NextResponse.json({ error: "cwd required" }, { status: 400 });
    if (!filePath) return NextResponse.json({ error: "filePath required" }, { status: 400 });

    const allowedRoots = await getAllowedFileRoots();
    if (!isExistingFilePathAllowed(cwd, allowedRoots)) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }

    const { skills } = await loadSkillsWithInstallInfo(cwd);
    if (!skills.some((skill) => skill.filePath === filePath)) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }

    const content = readFileSync(filePath, "utf8");
    const updated = setDisableModelInvocation(content, disableModelInvocation);
    writeFileSync(filePath, updated, "utf8");
    return NextResponse.json({ success: true });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
