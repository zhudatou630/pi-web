import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DefaultResourceLoader, ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const {
  autoTrustRefusal,
  findInheritingTrustProject,
  NESTED_PROJECT_SCAN_DEPTH,
  NESTED_PROJECT_SCAN_MAX_FOLDERS,
  trustProjectAutomatically,
  getProjectTrustStatus,
  projectTrustReloadOptions,
  trustProject,
} = await createJiti(import.meta.url).import("./project-trust.ts");

test("never auto-trusts a folder whose trust would spread to other work", () => {
  const home = "/home/u";
  const known = ["/home/u/code/app", "/home/u/notes"];
  assert.match(autoTrustRefusal("/", known, home), /home folder/);
  assert.match(autoTrustRefusal("/home", known, home), /home folder/);
  assert.match(autoTrustRefusal("/home/u", known, home), /home folder/);
  assert.match(autoTrustRefusal("/home/u/code", known, home), /contains another project \(\/home\/u\/code\/app\)/);
  assert.equal(autoTrustRefusal("/home/u/code/app", known, home), null);
  assert.equal(autoTrustRefusal("/home/u/fresh", known, home), null);
  assert.equal(autoTrustRefusal("/home/u/notes-old", known, home), null);
});

test("auto-trust refusal sees through a symlink to home, as the trust store does", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-auto-trust-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home");
  await mkdir(join(home, "repo"), { recursive: true });
  await symlink(home, join(root, "alias"));
  assert.match(autoTrustRefusal(join(root, "alias"), [], home), /home folder/);
  assert.match(autoTrustRefusal(join(root, "alias"), [join(home, "repo")], join(root, "elsewhere")), /another project/);
});

async function createProjectFixture(t) {
  const root = await mkdtemp(join(tmpdir(), "pi-web-project-trust-"));
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  await mkdir(cwd, { recursive: true });
  await mkdir(agentDir, { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, cwd, agentDir };
}

test("clean projects stay on the normal trusted load path", async (t) => {
  const { cwd, agentDir } = await createProjectFixture(t);

  assert.deepEqual(getProjectTrustStatus(cwd, agentDir), {
    requiresTrust: false,
    trusted: true,
  });
  assert.equal(projectTrustReloadOptions(cwd, agentDir), undefined);
});

test("project extensions execute only after the project is trusted", async (t) => {
  const { root, cwd, agentDir } = await createProjectFixture(t);
  const extensionDir = join(cwd, ".pi", "extensions");
  const marker = join(root, "extension-executed");
  await mkdir(extensionDir, { recursive: true });
  await writeFile(
    join(extensionDir, "probe.js"),
    `import { writeFileSync } from "node:fs";\nexport default () => { writeFileSync(${JSON.stringify(marker)}, "executed"); };\n`,
  );

  assert.deepEqual(getProjectTrustStatus(cwd, agentDir), {
    requiresTrust: true,
    trusted: false,
  });

  const restrictedLoader = new DefaultResourceLoader({ cwd, agentDir });
  await restrictedLoader.reload(projectTrustReloadOptions(cwd, agentDir));
  assert.equal(existsSync(marker), false);
  assert.equal(restrictedLoader.getExtensions().extensions.length, 0);

  assert.deepEqual(trustProject(cwd, agentDir), {
    requiresTrust: true,
    trusted: true,
  });

  const trustedLoader = new DefaultResourceLoader({ cwd, agentDir });
  await trustedLoader.reload(projectTrustReloadOptions(cwd, agentDir));
  assert.equal(existsSync(marker), true);
  assert.equal(trustedLoader.getExtensions().extensions.length, 1);
});

test("the reload resolver reads the latest persisted trust decision", async (t) => {
  const { cwd, agentDir } = await createProjectFixture(t);
  await mkdir(join(cwd, ".pi", "extensions"), { recursive: true });

  const reloadOptions = projectTrustReloadOptions(cwd, agentDir);
  assert.ok(reloadOptions);
  assert.equal(await reloadOptions.resolveProjectTrust(), false);

  trustProject(cwd, agentDir);
  assert.equal(await reloadOptions.resolveProjectTrust(), true);
});

test("unseen nested resources refuse automatic trust, while their own decisions win", async (t) => {
  const { root, cwd, agentDir } = await createProjectFixture(t);
  const child = join(cwd, "cloned");
  await mkdir(join(child, ".pi", "extensions"), { recursive: true });
  assert.match(autoTrustRefusal(cwd, [], join(root, "home"), agentDir), /unseen/);
  assert.throws(() => trustProjectAutomatically(cwd, agentDir), /unseen/);
  assert.equal(existsSync(join(agentDir, "trust.json")), false);
  const store = new ProjectTrustStore(agentDir);
  store.set(root, false);
  assert.match(findInheritingTrustProject(cwd, agentDir), /unseen/);
  store.set(root, null);
  for (const decision of [false, true]) {
    store.set(child, decision);
    assert.equal(findInheritingTrustProject(cwd, agentDir), null);
    assert.equal(store.get(child), decision);
  }
  // A decision on an intermediate folder also protects projects below it.
  store.set(child, null);
  store.set(join(cwd, "other"), false);
  await mkdir(join(cwd, "other", "repo", ".pi", "skills"), { recursive: true });
  store.set(child, false);
  assert.equal(findInheritingTrustProject(cwd, agentDir), null);
});

test("nested scan counts every resource and dangling links, and fails closed on malformed trust", async (t) => {
  const { root, agentDir } = await createProjectFixture(t);
  const resources = ["settings.json", "mcp.json", "extensions", "skills", "prompts", "themes", "SYSTEM.md", "APPEND_SYSTEM.md"];
  for (const resource of resources) {
    const folder = join(root, resource);
    const config = join(folder, "child", ".pi");
    await mkdir(config, { recursive: true });
    await symlink(join(root, "absent"), join(config, resource));
    assert.match(findInheritingTrustProject(folder, agentDir), /unseen/, resource);
  }
  const folder = join(root, "agents");
  await mkdir(join(folder, "child", ".agents"), { recursive: true });
  await symlink(join(root, "absent"), join(folder, "child", ".agents", "skills"));
  assert.match(findInheritingTrustProject(folder, agentDir), /unseen/);
  const dangling = join(root, "dangling");
  await mkdir(join(dangling, "child"), { recursive: true });
  await symlink(join(root, "absent"), join(dangling, "child", ".pi"));
  assert.match(findInheritingTrustProject(dangling, agentDir), /unseen/);
  await writeFile(join(agentDir, "trust.json"), "invalid json");
  assert.match(findInheritingTrustProject(folder, agentDir), /unseen/);
});

test("nested scan respects depth, skipped directories, directory links and the folder cap", async (t) => {
  const { root, cwd, agentDir } = await createProjectFixture(t);
  for (const name of ["node_modules", ".git", ".pi", ".agents"]) {
    await mkdir(join(cwd, name, "repo", ".pi", "extensions"), { recursive: true });
  }
  const outside = join(root, "outside");
  await mkdir(join(outside, ".pi", "extensions"), { recursive: true });
  await symlink(outside, join(cwd, "link"), process.platform === "win32" ? "junction" : "dir");
  const atLimit = join(cwd, ...Array(NESTED_PROJECT_SCAN_DEPTH).fill("deep"));
  await mkdir(join(atLimit, "deeper", ".pi", "extensions"), { recursive: true });
  assert.equal(findInheritingTrustProject(cwd, agentDir), null);
  await mkdir(join(atLimit, ".pi", "extensions"), { recursive: true });
  assert.match(findInheritingTrustProject(cwd, agentDir), /unseen/);
  const wide = join(root, "wide");
  await mkdir(wide);
  for (let i = 0; i < NESTED_PROJECT_SCAN_MAX_FOLDERS; i++) await mkdir(join(wide, String(i)));
  assert.match(findInheritingTrustProject(wide, agentDir), /too many folders/);
});

test("automatic trust rescans after the precheck, without changing explicit user trust", async (t) => {
  const { root, cwd, agentDir } = await createProjectFixture(t);
  assert.equal(autoTrustRefusal(cwd, [], join(root, "home"), agentDir), null);
  // Simulate the authored config and a clone landing while the caller awaited its write.
  await mkdir(join(cwd, ".pi"));
  await writeFile(join(cwd, ".pi", "mcp.json"), "{}");
  await mkdir(join(cwd, "new-clone", ".pi", "extensions"), { recursive: true });
  assert.throws(() => trustProjectAutomatically(cwd, agentDir), /unseen/);
  assert.equal(existsSync(join(agentDir, "trust.json")), false);
  assert.equal(getProjectTrustStatus(join(cwd, "new-clone"), agentDir).trusted, false);
  assert.equal(trustProject(cwd, agentDir).trusted, true);
});

test("all project resource loaders and reloads enforce project trust", async () => {
  const rpcSource = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const modelsSource = await readFile(new URL("../app/api/models/route.ts", import.meta.url), "utf8");
  const skillsSource = await readFile(new URL("./skills-service.ts", import.meta.url), "utf8");
  const skillsInstallSource = await readFile(new URL("../app/api/skills/install/route.ts", import.meta.url), "utf8");
  const pluginsSource = await readFile(new URL("../app/api/plugins/route.ts", import.meta.url), "utf8");

  assert.match(rpcSource, /const sessionCwd = sessionManager\.getCwd\(\)/);
  assert.match(rpcSource, /projectTrustReloadOptions\(sessionCwd, agentDir\)/);
  assert.match(rpcSource, /resourceLoaderReloadOptions: trustReloadOptions/);
  assert.equal(
    Array.from(rpcSource.matchAll(/this\.syncProjectTrust\(\);\s*await this\.inner\.reload/g)).length,
    2,
  );

  assert.match(modelsSource, /projectTrustReloadOptions\(cwd, agentDir\)/);
  assert.match(modelsSource, /resourceLoaderReloadOptions: trustReloadOptions/);
  assert.match(skillsSource, /loader\.reload\(projectTrustReloadOptions\(cwd, agentDir\)\)/);
  assert.match(pluginsSource, /projectTrusted: projectTrust\.trusted/);
  assert.match(
    skillsInstallSource,
    /getProjectTrustStatus\(cwd, getAgentDir\(\)\)\.trusted/,
  );
  assert.equal(
    Array.from(pluginsSource.matchAll(/projectTrusted: projectTrust\.trusted/g)).length,
    2,
  );
  assert.match(pluginsSource, /scope === "project" && !projectTrust\.trusted/);
});

test("the trust API invalidates cached models and restricted runtimes", async () => {
  const source = await readFile(new URL("../app/api/project-trust/route.ts", import.meta.url), "utf8");
  const rpcSource = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");

  assert.match(source, /trustProject\(result\.cwd, agentDir\)/);
  assert.match(source, /invalidateModelsCache\(\)/);
  assert.match(source, /destroyRpcSessionsForCwd\(result\.cwd\)/);
  assert.match(source, /hasBusyRpcSessionForCwd\(result\.cwd\)/);
  assert.match(rpcSource, /trackStartingSession\(sessionCwd\)/);
  assert.match(rpcSource, /realpathSync\(resolvedCwd\)/);
});
