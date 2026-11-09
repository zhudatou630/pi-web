import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";

const root = mkdtempSync(join(tmpdir(), "pi-web-project-overrides-"));
const agentDir = join(root, "agent");
const repo = join(root, "repo");
const worktree = join(root, "repo-worktrees", "feature");
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;

const pkg = join(root, "pkg");
const skill = join(pkg, "skills", "pkg-a", "SKILL.md");
mkdirSync(join(pkg, "skills", "pkg-a"), { recursive: true });
writeFileSync(skill, "---\nname: pkg-a\ndescription: a\n---\n");
const manualSkill = join(pkg, "skills", "pkg-m", "SKILL.md");
mkdirSync(join(pkg, "skills", "pkg-m"), { recursive: true });
writeFileSync(manualSkill, "---\nname: pkg-m\ndescription: m\ndisable-model-invocation: true\n---\n");
writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "pkg", pi: { skills: ["./skills"] } }));
mkdirSync(agentDir, { recursive: true });
writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [pkg] }));

const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { stdio: "pipe" });
mkdirSync(repo);
git(repo, "init", "-q");
writeFileSync(join(repo, ".gitignore"), "/.pi/\n");
git(repo, "add", ".");
git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
git(repo, "worktree", "add", "-q", "-b", "feature", worktree);

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() } });
const { allowFileRoot } = await jiti.import("../../../lib/file-access.ts");
const { GET, POST } = await jiti.import("./route.ts");
const { seedWorktreeOverrides } = await jiti.import("../../../lib/project-override-sync.ts");
allowFileRoot(repo);

after(() => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  rmSync(root, { recursive: true, force: true });
});

test("skills marked disable-model-invocation are flagged manualOnly", async () => {
  const res = await GET(new Request(`http://localhost/api/project-overrides?cwd=${encodeURIComponent(repo)}`));
  const items = (await res.json()).groups.flatMap((group) => group.items);
  assert.equal(items.find((item) => item.path === manualSkill)?.manualOnly, true);
  assert.equal(items.find((item) => item.path === skill)?.manualOnly, undefined);
});

const settings = (dir) => JSON.parse(readFileSync(join(dir, ".pi", "settings.json"), "utf8"));

test("a project override is written to every worktree of the repo", async () => {
  const get = await GET(new Request(`http://localhost/api/project-overrides?cwd=${encodeURIComponent(repo)}`));
  assert.deepEqual((await get.json()).sync, { kind: "worktrees", otherWorktrees: 1 });

  const res = await POST(new Request("http://localhost/api/project-overrides", {
    method: "POST",
    headers: { "Content-Type": "application/json", Host: "localhost" },
    body: JSON.stringify({ cwd: repo, enabled: false, targets: [{ type: "skills", path: skill }] }),
  }));
  assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
  assert.deepEqual((await res.json()).failures, []);
  const expected = [{ source: "../../pkg", autoload: false, skills: ["-skills/pkg-a/SKILL.md"] }];
  assert.deepEqual(settings(repo).packages, expected);
  // Local package sources are written relative to each checkout's .pi directory.
  assert.deepEqual(settings(worktree).packages, [{ ...expected[0], source: "../../../pkg" }]);
});

test("a new worktree starts with the overrides of the checkout it came from", async () => {
  const fresh = join(root, "repo-worktrees", "fresh");
  git(repo, "worktree", "add", "-q", "-b", "fresh", fresh);
  assert.equal(existsSync(join(fresh, ".pi", "settings.json")), false);
  await seedWorktreeOverrides(repo, fresh, agentDir);
  assert.deepEqual(settings(fresh).packages, settings(worktree).packages);
});

test("MCP overrides of global servers follow the same worktree sync; own project servers are left alone", async () => {
  const { PATCH, DELETE } = await jiti.import("../mcp/route.ts");
  const send = (handler, method, body) => handler(new Request("http://localhost/api/mcp", {
    method, headers: { "Content-Type": "application/json", Host: "localhost" }, body: JSON.stringify(body),
  }));
  const mcp = (dir) => JSON.parse(readFileSync(join(dir, ".pi", "mcp.json"), "utf8")).mcpServers;
  writeFileSync(join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: { g: { command: "node" }, own: { command: "node" } } }));
  writeFileSync(join(worktree, ".pi", "mcp.json"), JSON.stringify({ mcpServers: { own: { command: "local" } } }));

  for (const name of ["g", "own"]) {
    const response = await send(PATCH, "PATCH", { cwd: repo, scope: "project", name, override: true, enabled: false });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).failures, []);
  }
  assert.deepEqual(mcp(repo), { g: { enabled: false }, own: { enabled: false } });
  assert.deepEqual(mcp(worktree), { own: { command: "local" }, g: { enabled: false } });

  const fresh = join(root, "repo-worktrees", "mcp-fresh");
  git(repo, "worktree", "add", "-q", "-b", "mcp-fresh", fresh);
  await seedWorktreeOverrides(repo, fresh, agentDir);
  assert.deepEqual(mcp(fresh), mcp(repo));

  await send(PATCH, "PATCH", { cwd: repo, scope: "project", name: "g", override: true, enabled: null });
  await send(DELETE, "DELETE", { cwd: repo, scope: "project", name: "own" });
  assert.deepEqual(mcp(repo), {});
  assert.deepEqual(mcp(worktree), { own: { command: "local" } });
  assert.deepEqual(mcp(fresh), {});
});

test("MCP sync skips a worktree whose branch tracks .pi/mcp.json, and an untrusted source is not seeded", async () => {
  const { PATCH } = await jiti.import("../mcp/route.ts");
  const { getProjectTrustStatus } = await jiti.import("../../../lib/project-trust.ts");
  const tracked = join(root, "repo-worktrees", "tracked");
  git(repo, "worktree", "add", "-q", "-b", "tracked", tracked);
  mkdirSync(join(tracked, ".pi"), { recursive: true });
  writeFileSync(join(tracked, ".pi", "mcp.json"), JSON.stringify({ mcpServers: {} }));
  git(tracked, "add", "-f", ".pi/mcp.json");
  writeFileSync(join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: { g: { command: "node" } } }));
  await PATCH(new Request("http://localhost/api/mcp", {
    method: "PATCH", headers: { "Content-Type": "application/json", Host: "localhost" },
    body: JSON.stringify({ cwd: repo, scope: "project", name: "g", override: true, enabled: false }),
  }));
  assert.deepEqual(JSON.parse(readFileSync(join(tracked, ".pi", "mcp.json"), "utf8")).mcpServers, {});

  const outside = join(root, "untrusted-src"), target = join(root, "seed-target");
  mkdirSync(join(outside, ".pi"), { recursive: true });
  mkdirSync(target);
  writeFileSync(join(outside, ".pi", "mcp.json"), JSON.stringify({ mcpServers: { g: { enabled: true } } }));
  assert.equal(getProjectTrustStatus(outside, agentDir).trusted, false);
  await seedWorktreeOverrides(outside, target, agentDir);
  assert.equal(existsSync(join(target, ".pi", "mcp.json")), false);
});
