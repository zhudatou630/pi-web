import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const testAgentDir = await mkdtemp(join(tmpdir(), "pi-web-subagents-global-"));
process.env.PI_CODING_AGENT_DIR = testAgentDir;

const {
  deleteSubagentProfile,
  importAgentProfiles,
  countImportableAgentFiles,
  listImportableAgentFiles,
  listSubagentProfileSources,
  listSubagentProfiles,
  readSubagentRun,
  readSubagentSessionResources,
  resolveSubagentProfile,
  saveSubagentProfile,
  selectSubagentExtensionTools,
  setSubagentProfileEnabled,
  setSubagentProjectAvailability,
  SUBAGENT_META_TYPE,
  SUBAGENT_RESULT_TYPE,
  withSubagentExtensionTools,
} = await createJiti(import.meta.url).import("./subagents.ts");
const { ProjectNotTrustedError } = await createJiti(import.meta.url).import("./project-resource-overrides.ts");
const { trustProject } = await createJiti(import.meta.url).import("./project-trust.ts");
const { subagentProfileSources } = await createJiti(import.meta.url).import("./subagent-profile-precedence.ts");

after(async () => {
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  await rm(testAgentDir, { recursive: true, force: true });
});

function profile(overrides = {}) {
  return {
    name: "test-agent",
    displayName: " Test agent ",
    description: " Test description ",
    systemPrompt: " Test prompt. ",
    tools: ["read", "read"],
    loadSkills: false,
    loadExtensions: false,
    model: " provider/model ",
    thinking: "high",
    maxTurns: 4.9,
    inheritContext: false,
    runInBackground: false,
    enabled: true,
    ...overrides,
  };
}

test("built-in profile IDs use lowercase kebab-case and read-only profiles cannot execute shell commands", () => {
  const profiles = listSubagentProfiles(testAgentDir);
  for (const builtin of profiles.filter((item) => item.scope === "builtin")) {
    assert.match(builtin.name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  }
  for (const name of ["explore", "plan"]) {
    const builtin = profiles.find((item) => item.name === name);
    assert.deepEqual(builtin.tools, ["read", "grep", "find", "ls"]);
    assert.equal(builtin.tools.includes("bash"), false);
  }
});

test("profile sources order by scope precedence case-insensitively", () => {
  const profiles = [
    { name: "Reviewer", scope: "builtin" },
    { name: "reviewer", scope: "global" },
    { name: "REVIEWER", scope: "workspace" },
    { name: "Reviewer", scope: "project" },
    { name: "other", scope: "builtin" },
  ];
  assert.deepEqual(subagentProfileSources(profiles, "reviewer").map((item) => item.scope), ["project", "workspace", "global", "builtin"]);
});

test("project profiles override built-ins and round-trip their runtime settings", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-subagents-"));
  try {
    saveSubagentProfile(cwd, "project", {
      name: "Explore",
      displayName: "Repository scout",
      description: "Inspect this repository",
      systemPrompt: "Read carefully and report findings.",
      tools: ["read", "grep"],
      loadSkills: true,
      loadExtensions: true,
      model: "anthropic/test-model",
      thinking: "high",
      maxTurns: 8,
      inheritContext: true,
      runInBackground: true,
      enabled: true,
    });

    const profile = listSubagentProfiles(cwd).find((item) => item.name === "Explore");
    assert.equal(profile.scope, "project");
    assert.equal(profile.displayName, "Repository scout");
    assert.deepEqual(profile.tools, ["read", "grep"]);
    assert.equal(profile.loadSkills, true);
    assert.equal(profile.loadExtensions, true);
    assert.equal(profile.thinking, "high");
    assert.equal(profile.maxTurns, 8);
    assert.equal(profile.inheritContext, true);
    assert.equal(profile.runInBackground, true);

    const source = await readFile(join(cwd, ".pi", "agents", "Explore.md"), "utf8");
    assert.match(source, /max_turns: 8/);
    assert.match(source, /load_skills: true/);
    assert.match(source, /load_extensions: true/);
    assert.match(source, /Read carefully and report findings\./);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("extension selectors stay off the builtin tool list and enable extension loading", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-subagents-"));
  try {
    await mkdir(join(cwd, ".pi", "agents"), { recursive: true });
    await writeFile(
      join(cwd, ".pi", "agents", "legacy.md"),
      "---\ndescription: Legacy\ntools: read, ext:mcp/search, write\ndisallowed_tools: write\n---\nInspect only.\n",
    );
    const profile = listSubagentProfiles(cwd).find((item) => item.name === "legacy");
    assert.deepEqual(profile.tools, ["read"]);
    assert.deepEqual(profile.extensionTools, ["ext:mcp/search"]);
    assert.equal(profile.loadSkills, false);
    assert.equal(profile.loadExtensions, true);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("persisted subagent metadata reconstructs the final run", () => {
  const entries = [
    {
      type: "custom",
      customType: SUBAGENT_META_TYPE,
      id: "meta",
      parentId: null,
      timestamp: "2026-01-01T00:00:00.000Z",
      data: {
        version: 1,
        parentSessionId: "parent",
        parentSessionPath: "/tmp/parent.jsonl",
        parentToolCallId: "tool-call",
        profile: "Explore",
        description: "Find the parser",
        task: "Locate parser code",
        runInBackground: true,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    },
    {
      type: "custom",
      customType: SUBAGENT_RESULT_TYPE,
      id: "result",
      parentId: "meta",
      timestamp: "2026-01-01T00:01:00.000Z",
      data: {
        version: 1,
        status: "completed",
        completedAt: "2026-01-01T00:01:00.000Z",
        wrappedAtTurnLimit: true,
        result: "Located it.",
      },
    },
  ];

  assert.deepEqual(readSubagentRun(entries, "child", "/tmp/child.jsonl"), {
    sessionId: "child",
    sessionPath: "/tmp/child.jsonl",
    parentSessionId: "parent",
    parentToolCallId: "tool-call",
    profile: "Explore",
    description: "Find the parser",
    task: "Locate parser code",
    runInBackground: true,
    status: "completed",
    createdAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:01:00.000Z",
    wrappedAtTurnLimit: true,
    result: "Located it.",
  });
});

test("persisted subagent resources restore the exact isolated prompt and tools", () => {
  const entries = [{
    type: "custom",
    customType: SUBAGENT_META_TYPE,
    id: "meta",
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    data: {
      version: 1,
      parentSessionId: "parent",
      parentSessionPath: "/tmp/parent.jsonl",
      profile: "reviewer",
      resourceSnapshot: {
        version: 1,
        appendSystemPrompt: ["Review carefully.", "Inherited parent context."],
        tools: ["read", "grep", "web_search", "read"],
        loadSkills: true,
        loadExtensions: true,
      },
    },
  }];

  assert.deepEqual(readSubagentSessionResources(entries), {
    appendSystemPrompt: ["Review carefully.", "Inherited parent context."],
    tools: ["read", "grep", "web_search"],
    loadSkills: true,
    loadExtensions: true,
  });
});

test("latest resource metadata wins and unfinished runs are interrupted after restart", () => {
  const meta = {
    type: "custom",
    customType: SUBAGENT_META_TYPE,
    id: "meta",
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    data: {
      version: 1,
      parentSessionId: "parent",
      parentSessionPath: "/tmp/parent.jsonl",
      parentToolCallId: "tool-call",
      profile: "reviewer",
      description: "Review",
      task: "Review files",
      runInBackground: true,
      createdAt: "2026-01-01T00:00:00.000Z",
      resourceSnapshot: {
        version: 1,
        appendSystemPrompt: ["Review."],
        tools: ["read"],
        loadSkills: false,
        loadExtensions: true,
      },
    },
  };
  const updated = {
    ...meta,
    id: "meta-updated",
    data: {
      ...meta.data,
      resourceSnapshot: { ...meta.data.resourceSnapshot, tools: ["read", "search"] },
    },
  };
  const queued = {
    ...meta,
    id: "queued",
    customType: "pi-web:subagent-status",
    data: { version: 1, status: "queued" },
  };

  assert.deepEqual(readSubagentSessionResources([meta, updated]), {
    appendSystemPrompt: ["Review."],
    tools: ["read", "search"],
    loadSkills: false,
    loadExtensions: true,
  });
  assert.equal(readSubagentRun([meta, queued], "child", "/tmp/child.jsonl").status, "interrupted");
});

test("legacy subagent resource snapshots keep skills and extensions disabled", () => {
  const entries = [{
    type: "custom",
    customType: SUBAGENT_META_TYPE,
    data: {
      version: 1,
      parentSessionId: "parent",
      parentSessionPath: "/tmp/parent.jsonl",
      resourceSnapshot: {
        version: 1,
        appendSystemPrompt: ["Stay focused."],
        tools: ["read"],
      },
    },
  }];

  assert.deepEqual(readSubagentSessionResources(entries), {
    appendSystemPrompt: ["Stay focused."],
    tools: ["read"],
    loadSkills: false,
    loadExtensions: false,
  });
});

test("extension tools are merged while subagent control tools stay excluded", () => {
  assert.deepEqual(
    withSubagentExtensionTools(
      ["read"],
      ["web_search", "Agent", "get_subagent_result", "steer_subagent", "web_search"],
    ),
    ["read", "web_search"],
  );
});

test("an empty tool selection round-trips without restoring default tools", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-subagents-"));
  try {
    const saved = saveSubagentProfile(cwd, "project", profile({ tools: [] }));
    const loaded = listSubagentProfiles(cwd).find((item) => item.name === saved.name);
    const source = await readFile(join(cwd, ".pi", "agents", `${saved.name}.md`), "utf8");

    assert.deepEqual(saved.tools, []);
    assert.deepEqual(loaded.tools, []);
    assert.match(source, /tools: none/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("saved profiles normalize runtime values and reject invalid settings", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-subagents-"));
  try {
    const saved = saveSubagentProfile(cwd, "project", profile());
    assert.equal(saved.displayName, "Test agent");
    assert.equal(saved.description, "Test description");
    assert.equal(saved.systemPrompt, "Test prompt.");
    assert.deepEqual(saved.tools, ["read"]);
    assert.equal(saved.model, "provider/model");
    assert.equal(saved.maxTurns, 4);
    assert.equal(saved.loadSkills, false);
    assert.equal(saved.loadExtensions, false);

    saveSubagentProfile(cwd, "project", profile({
      name: "isolated-agent",
      promptMode: "replace",
      isolation: "worktree",
    }));
    const configured = listSubagentProfiles(cwd).find((item) => item.name === "isolated-agent");
    assert.equal(configured.promptMode, "replace");
    assert.equal(configured.isolation, "worktree");

    assert.throws(
      () => saveSubagentProfile(cwd, "project", profile({ name: "../escape" })),
      /Agent name may contain only/,
    );
    assert.throws(
      () => saveSubagentProfile(cwd, "project", profile({ thinking: "extreme" })),
      /Invalid thinking level/,
    );
    assert.throws(
      () => saveSubagentProfile(cwd, "project", profile({ maxTurns: Number.POSITIVE_INFINITY })),
      /Max turns must be a non-negative number/,
    );
    assert.throws(
      () => saveSubagentProfile(cwd, "project", profile({ maxTurns: -1 })),
      /Max turns must be a non-negative number/,
    );
    assert.throws(
      () => saveSubagentProfile(cwd, "project", profile({ tools: ["read", "reed"] })),
      /Unknown subagent tools: reed/,
    );
    assert.throws(
      () => saveSubagentProfile(cwd, "project", profile({ tools: "read" })),
      /Subagent tools must be an array of strings/,
    );
    assert.throws(
      () => saveSubagentProfile(cwd, "project", profile({ extensionTools: "ext:mcp" })),
      /extensionTools must be an array of strings/,
    );
    assert.throws(
      () => saveSubagentProfile(cwd, "project", profile({ extensionTools: ["mcp/search"] })),
      /Invalid subagent extension tools/,
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("project profiles override workspace profiles and deletion restores the workspace version", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-subagents-"));
  try {
    await mkdir(join(cwd, ".agents", "agents"), { recursive: true });
    await writeFile(
      join(cwd, ".agents", "agents", "test-agent.md"),
      "---\ndescription: Workspace version\ntools: read\n---\nWorkspace prompt.\n",
    );
    saveSubagentProfile(cwd, "project", profile({ description: "Project version" }));
    assert.equal(resolveSubagentProfile(cwd, "TEST-AGENT").description, "Project version");

    deleteSubagentProfile(cwd, "project", "test-agent");
    const restored = resolveSubagentProfile(cwd, "test-agent");
    assert.equal(restored.scope, "workspace");
    assert.equal(restored.description, "Workspace version");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("global and project sources with the same name stay visible while project wins at runtime", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-subagents-"));
  try {
    saveSubagentProfile(cwd, "global", profile({ description: "Global version" }));
    saveSubagentProfile(cwd, "project", profile({ description: "Project version" }));

    const sources = listSubagentProfileSources(cwd)
      .filter((item) => item.name === "test-agent")
      .sort((a, b) => a.scope.localeCompare(b.scope));
    assert.deepEqual(sources.map((item) => item.scope), ["global", "project"]);
    assert.deepEqual(sources.map((item) => item.description), ["Global version", "Project version"]);

    const effective = resolveSubagentProfile(cwd, "test-agent");
    assert.equal(effective.scope, "project");
    assert.equal(effective.description, "Project version");
  } finally {
    deleteSubagentProfile(cwd, "global", "test-agent");
    await rm(cwd, { recursive: true, force: true });
  }
});

test("global profiles round-trip and deleting an override restores the built-in", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-subagents-"));
  try {
    const saved = saveSubagentProfile(cwd, "global", profile({
      name: "Explore",
      displayName: "Global explorer",
      description: "Global override",
      tools: ["read", "grep"],
    }));
    assert.equal(saved.scope, "global");
    assert.equal(saved.filePath, join(testAgentDir, "agents", "Explore.md"));
    assert.equal(resolveSubagentProfile(cwd, "Explore").scope, "global");
    assert.equal(resolveSubagentProfile(cwd, "Explore").description, "Global override");

    deleteSubagentProfile(cwd, "global", "Explore");
    const restored = resolveSubagentProfile(cwd, "Explore");
    assert.equal(restored.scope, "builtin");
    assert.equal(restored.displayName, "Explore");
  } finally {
    deleteSubagentProfile(cwd, "global", "Explore");
    await rm(cwd, { recursive: true, force: true });
  }
});

test("a disabled top file hides lower definitions instead of falling back", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-subagents-"));
  try {
    saveSubagentProfile(cwd, "global", profile({ description: "Global version" }));
    saveSubagentProfile(cwd, "project", profile({ enabled: false }));
    assert.equal(resolveSubagentProfile(cwd, "test-agent"), undefined);
    assert.equal(listSubagentProfiles(cwd).find((item) => item.name === "test-agent").scope, "project");

    setSubagentProfileEnabled(cwd, "test-agent", true);
    assert.equal(resolveSubagentProfile(cwd, "test-agent").scope, "project");
  } finally {
    deleteSubagentProfile(cwd, "global", "test-agent");
    await rm(cwd, { recursive: true, force: true });
  }
});

test("disabling a built-in writes a global stub and enabling removes it", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-subagents-"));
  try {
    const stubPath = join(testAgentDir, "agents", "explore.md");
    setSubagentProfileEnabled(cwd, "Explore", false);
    assert.equal(readFileSync(stubPath, "utf8"), "---\nenabled: false\n---\n");
    assert.equal(resolveSubagentProfile(cwd, "explore"), undefined);
    const top = listSubagentProfiles(cwd).find((item) => item.name === "explore");
    assert.equal(top.disableStub, true);
    assert.equal(top.scope, "global");
    assert.equal(existsSync(join(cwd, ".pi", "agents", "explore.md")), false);

    setSubagentProfileEnabled(cwd, "explore", true);
    assert.equal(existsSync(stubPath), false);
    assert.equal(resolveSubagentProfile(cwd, "explore").scope, "builtin");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("workspace profiles are toggled in place", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-subagents-"));
  try {
    const dir = join(cwd, ".agents", "agents");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "reviewer.md"), "---\ndescription: Review\nowner: team\n---\nReview carefully.\n");
    setSubagentProfileEnabled(cwd, "reviewer", false);
    const text = readFileSync(join(dir, "reviewer.md"), "utf8");
    assert.match(text, /enabled: false/);
    assert.match(text, /owner: team/);
    assert.match(text, /Review carefully\./);
    assert.equal(existsSync(join(cwd, ".pi", "agents", "reviewer.md")), false);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("persisted runs distinguish interrupted, failed, aborted, and latest results", () => {
  const meta = {
    type: "custom",
    customType: SUBAGENT_META_TYPE,
    id: "meta",
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    data: {
      version: 1,
      parentSessionId: "parent",
      parentSessionPath: "/tmp/parent.jsonl",
      parentToolCallId: "tool-call",
      profile: "Explore",
      description: "Inspect",
      task: "Inspect files",
      runInBackground: false,
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  };
  assert.equal(readSubagentRun([meta], "child", "/tmp/child.jsonl").status, "interrupted");

  const failed = {
    ...meta,
    id: "failed",
    customType: SUBAGENT_RESULT_TYPE,
    data: { version: 1, status: "failed", completedAt: "2026-01-01T00:01:00.000Z", error: "boom" },
  };
  const aborted = {
    ...failed,
    id: "aborted",
    data: { version: 1, status: "aborted", completedAt: "2026-01-01T00:02:00.000Z" },
  };
  assert.equal(readSubagentRun([meta, failed], "child", "/tmp/child.jsonl").status, "failed");
  assert.equal(readSubagentRun([meta, failed], "child", "/tmp/child.jsonl").error, "boom");
  assert.equal(readSubagentRun([meta, failed, aborted], "child", "/tmp/child.jsonl").status, "aborted");
  assert.equal(readSubagentRun([{ ...meta, data: { version: 2 } }], "child", "/tmp/child.jsonl"), null);
});

test("project profile directories cannot escape cwd through symbolic links", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "pi-web-subagent-boundary-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const cwd = join(base, "project");
  const outside = join(base, "outside");
  await mkdir(join(cwd, ".agents"), { recursive: true });
  await mkdir(join(cwd, ".pi"), { recursive: true });
  await mkdir(outside);
  await writeFile(join(outside, "secret.md"), "---\ndescription: Secret\n---\nprivate\n");

  try {
    await symlink(outside, join(cwd, ".agents", "agents"), process.platform === "win32" ? "junction" : "dir");
    await symlink(outside, join(cwd, ".pi", "agents"), process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if (error?.code === "EPERM") {
      t.skip("Creating symbolic links requires additional privileges on this platform");
      return;
    }
    throw error;
  }

  assert.equal(listSubagentProfileSources(cwd).some((item) => item.name === "secret"), false);
  assert.equal(listSubagentProfiles(cwd).some((item) => item.name === "secret"), false);
  assert.throws(
    () => saveSubagentProfile(cwd, "project", profile({ name: "escaped" })),
    /outside the project root/,
  );
  assert.throws(
    () => deleteSubagentProfile(cwd, "project", "secret"),
    /outside the project root/,
  );
  assert.match(await readFile(join(outside, "secret.md"), "utf8"), /private/);
});

test("saving a profile round-trips unknown frontmatter and ext: selectors", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-subagents-"));
  try {
    await mkdir(join(cwd, ".pi", "agents"), { recursive: true });
    await writeFile(
      join(cwd, ".pi", "agents", "orchestrator.md"),
      [
        "---",
        "name: orchestrator",
        "description: Orchestrator",
        "tools: read, ext:pi-advisor-flow",
        "allowed_subagents: explore, plan",
        "isolation: worktree",
        "prompt_mode: replace",
        "---",
        "Delegate carefully.",
        "",
      ].join("\n"),
    );

    const loaded = listSubagentProfiles(cwd).find((item) => item.name === "orchestrator");
    assert.deepEqual(loaded.extensionTools, ["ext:pi-advisor-flow"]);
    assert.equal(loaded.isolation, "worktree");
    assert.equal(loaded.promptMode, "replace");

    saveSubagentProfile(cwd, "project", {
      ...loaded,
      description: "Updated orchestrator",
      enabled: true,
    });
    const source = await readFile(join(cwd, ".pi", "agents", "orchestrator.md"), "utf8");
    assert.match(source, /name: orchestrator/);
    assert.match(source, /allowed_subagents:/);
    assert.match(source, /ext:pi-advisor-flow/);
    assert.match(source, /isolation: worktree/);
    assert.match(source, /prompt_mode: replace/);
    assert.match(source, /Updated orchestrator/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("named skills and extensions fail closed instead of widening to all resources", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-subagents-"));
  try {
    await mkdir(join(cwd, ".pi", "agents"), { recursive: true });
    await writeFile(
      join(cwd, ".pi", "agents", "aliased.md"),
      "---\ndescription: Aliased\nskills: true\nextensions: pi-advisor-flow\n---\nUse the whitelist.\n",
    );
    const loaded = listSubagentProfiles(cwd).find((item) => item.name === "aliased");
    assert.equal(loaded.enabled, false);
    assert.equal(loaded.loadSkills, false);
    assert.equal(loaded.loadExtensions, false);
    assert.match(loaded.configurationError, /extensions named lists are not supported/);
    assert.throws(
      () => resolveSubagentProfile(cwd, "aliased"),
      /Invalid subagent profile.*extensions named lists are not supported/,
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("invalid project profiles remain authoritative and report their configuration errors", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-subagents-"));
  try {
    await mkdir(join(cwd, ".pi", "agents"), { recursive: true });
    await writeFile(
      join(cwd, ".pi", "agents", "Explore.md"),
      "---\ndescription: Broken override\ntools: read, reed\n---\nInspect.\n",
    );

    const unknownTool = listSubagentProfiles(cwd).find((item) => item.name === "Explore");
    assert.equal(unknownTool.scope, "project");
    assert.equal(unknownTool.enabled, false);
    assert.match(unknownTool.configurationError, /Unknown subagent tools: reed/);
    assert.throws(
      () => resolveSubagentProfile(cwd, "Explore"),
      /Invalid subagent profile.*Unknown subagent tools: reed/,
    );

    await writeFile(join(cwd, ".pi", "agents", "Explore.md"), "---\ninvalid: [\n---\nInspect.\n");
    const malformed = listSubagentProfiles(cwd).find((item) => item.name === "Explore");
    assert.equal(malformed.scope, "project");
    assert.match(malformed.configurationError, /Invalid frontmatter/);
    assert.throws(() => resolveSubagentProfile(cwd, "Explore"), /Invalid frontmatter/);

    await writeFile(join(cwd, ".pi", "agents", "Explore.md"), "---\ntools: 42\n---\nInspect.\n");
    assert.throws(
      () => resolveSubagentProfile(cwd, "Explore"),
      /Subagent tools must be a string or an array of strings/,
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("extension tool selectors match package names and optional tool names", () => {
  const extensions = [
    {
      path: "/tmp/node_modules/pi-advisor-flow/index.ts",
      sourceInfo: { source: "npm:pi-advisor-flow" },
      tools: new Map([["advise", {}], ["Agent", {}]]),
    },
    {
      path: "/tmp/node_modules/other-ext/index.ts",
      sourceInfo: { source: "npm:other-ext" },
      tools: new Map([["search", {}]]),
    },
  ];
  assert.deepEqual(selectSubagentExtensionTools(extensions, ["ext:pi-advisor-flow"]), ["advise"]);
  assert.deepEqual(selectSubagentExtensionTools(extensions, ["ext:other-ext/search"]), ["search"]);
  assert.deepEqual(
    [...selectSubagentExtensionTools(extensions, ["ext:*"])].sort(),
    ["advise", "search"],
  );
});

test("project availability switch writes a stub, then drops it back to the inherited state", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-subagents-avail-"));
  try {
    saveSubagentProfile(cwd, "global", profile({ name: "reviewer" }));
    const stubPath = join(cwd, ".pi", "agents", "reviewer.md");

    setSubagentProjectAvailability(cwd, "reviewer", false);
    assert.equal(readFileSync(stubPath, "utf8"), "---\nenabled: false\n---\n");
    assert.equal(resolveSubagentProfile(cwd, "reviewer"), undefined);

    // Already a stub: disabling again does nothing, enabling removes it.
    setSubagentProjectAvailability(cwd, "reviewer", false);
    assert.equal(existsSync(stubPath), true);
    setSubagentProjectAvailability(cwd, "reviewer", true);
    assert.equal(existsSync(stubPath), false);
    assert.equal(resolveSubagentProfile(cwd, "reviewer").scope, "global");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("project availability toggles a project definition in place and ignores inherited off agents", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-subagents-avail2-"));
  try {
    saveSubagentProfile(cwd, "project", profile({ name: "local-only", enabled: true }));
    const projectPath = join(cwd, ".pi", "agents", "local-only.md");

    setSubagentProjectAvailability(cwd, "local-only", false);
    let text = readFileSync(projectPath, "utf8");
    assert.match(text, /enabled: false/);
    assert.match(text, /Test prompt/);
    setSubagentProjectAvailability(cwd, "local-only", true);
    assert.match(readFileSync(projectPath, "utf8"), /enabled: true/);

    // A globally-disabled agent with no project file stays off; there is no definition to enable.
    saveSubagentProfile(cwd, "global", profile({ name: "elsewhere", enabled: false }));
    setSubagentProjectAvailability(cwd, "elsewhere", true);
    assert.equal(existsSync(join(cwd, ".pi", "agents", "elsewhere.md")), false);
    setSubagentProjectAvailability(cwd, "elsewhere", false);
    assert.equal(existsSync(join(cwd, ".pi", "agents", "elsewhere.md")), false);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("import previews and byte-copies definitions, skipping conflicts and invalid files", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-subagents-import-"));
  const source = await mkdtemp(join(tmpdir(), "pi-web-subagents-src-"));
  try {
    mkdirSync(join(source, ".pi", "agents"), { recursive: true });
    writeFileSync(join(source, ".pi", "agents", "good.md"), "---\ndescription: Imported\nowner: team\n---\nImported prompt.\n");
    writeFileSync(join(source, ".pi", "agents", "broken.md"), "---\nbroken: [\n---\n");
    saveSubagentProfile(cwd, "project", profile({ name: "conflict" }));
    writeFileSync(join(source, ".pi", "agents", "conflict.md"), "---\ndescription: Clash\n---\nClash.\n");

    const items = listImportableAgentFiles(cwd, source);
    assert.equal(countImportableAgentFiles(source), 3);
    const byFile = new Map(items.map((item) => [item.file, item]));
    assert.equal(byFile.get("good.md").error, undefined);
    assert.deepEqual(byFile.get("good.md").existsIn, { global: false, project: false });
    assert.ok(byFile.get("broken.md").error);
    assert.deepEqual(byFile.get("conflict.md").existsIn, { global: false, project: true });

    const result = importAgentProfiles(cwd, source, "project", ["good.md", "broken.md", "conflict.md", "../escape.md"]);
    assert.deepEqual(result.imported, ["good.md"]);
    const reasons = new Map(result.skipped.map((skip) => [skip.file, skip.reason]));
    assert.match(reasons.get("broken.md"), /Invalid/i);
    assert.equal(reasons.get("conflict.md"), "Already exists");
    assert.equal(reasons.get("../escape.md"), "Invalid file name");
    // Byte copy keeps frontmatter keys the app does not model.
    const text = readFileSync(join(cwd, ".pi", "agents", "good.md"), "utf8");
    assert.match(text, /owner: team/);
    assert.match(text, /Imported prompt/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await rm(source, { recursive: true, force: true });
  }
});

test("import neither previews nor follows symlinks", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-subagents-link-"));
  const source = await mkdtemp(join(tmpdir(), "pi-web-subagents-link-src-"));
  const outside = await mkdtemp(join(tmpdir(), "pi-web-subagents-link-out-"));
  t.after(() => Promise.all([rm(cwd, { recursive: true, force: true }), rm(source, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]));
  const secretPath = join(outside, "secret.md");
  writeFileSync(secretPath, "---\ndescription: Secret\n---\nSecret prompt.\n");
  mkdirSync(join(source, ".pi", "agents"), { recursive: true });
  await symlink(secretPath, join(source, ".pi", "agents", "link.md"));

  // The preview lists regular files only, so the link is never offered.
  assert.deepEqual(listImportableAgentFiles(cwd, source), []);

  // Even a hand-crafted request cannot pull the link target into the project.
  const result = importAgentProfiles(cwd, source, "project", ["link.md"]);
  assert.deepEqual(result.imported, []);
  assert.equal(result.skipped[0].reason, "Not a regular file");
  assert.equal(existsSync(join(cwd, ".pi", "agents", "link.md")), false);
});

test("writes into a trust-requiring project are refused until the project is trusted", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-subagents-trust-"));
  try {
    // .pi/settings.json is on the SDK's trust-requiring resource list.
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "settings.json"), "{}\n");

    assert.throws(() => saveSubagentProfile(cwd, "project", profile({ name: "gated" })), ProjectNotTrustedError);
    assert.throws(() => setSubagentProjectAvailability(cwd, "explore", false), ProjectNotTrustedError);
    assert.throws(() => importAgentProfiles(cwd, cwd, "project", ["x.md"]), ProjectNotTrustedError);
    assert.equal(existsSync(join(cwd, ".pi", "agents")), false);

    trustProject(cwd, testAgentDir);
    saveSubagentProfile(cwd, "project", profile({ name: "gated" }));
    assert.equal(existsSync(join(cwd, ".pi", "agents", "gated.md")), true);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("availability switch toggles a file whose basename differs from its frontmatter name", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-subagents-case-"));
  try {
    const dir = join(cwd, ".pi", "agents");
    mkdirSync(dir, { recursive: true });
    // Hand-written: basename reviewer.md, frontmatter name Reviewer.
    writeFileSync(join(dir, "reviewer.md"), "---\nname: Reviewer\ndescription: Review\n---\nReview carefully.\n");

    setSubagentProjectAvailability(cwd, "Reviewer", false);
    const text = readFileSync(join(dir, "reviewer.md"), "utf8");
    assert.match(text, /enabled: false/);
    assert.match(text, /Review carefully\./);
    // The toggle must stay inside the original file, never fork a second definition.
    assert.equal(existsSync(join(dir, "Reviewer.md")), false);

    setSubagentProjectAvailability(cwd, "Reviewer", true);
    assert.match(readFileSync(join(dir, "reviewer.md"), "utf8"), /enabled: true/);
    assert.equal(existsSync(join(dir, "Reviewer.md")), false);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("import treats the same logical agent under a different file name as existing", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-subagents-logical-"));
  const source = await mkdtemp(join(tmpdir(), "pi-web-subagents-logical-src-"));
  try {
    mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "agents", "alice.md"), "---\nname: alice\ndescription: A\n---\nA.\n");
    // Same logical agent (name: alice) under a different file name in the source.
    mkdirSync(join(source, ".pi", "agents"), { recursive: true });
    writeFileSync(join(source, ".pi", "agents", "bob.md"), "---\nname: alice\ndescription: Clone\n---\nClone.\n");

    const [preview] = listImportableAgentFiles(cwd, source);
    assert.equal(preview.existsIn.project, true);

    const result = importAgentProfiles(cwd, source, "project", ["bob.md"]);
    assert.deepEqual(result.imported, []);
    assert.equal(result.skipped[0].reason, "Already exists");
    assert.equal(existsSync(join(cwd, ".pi", "agents", "bob.md")), false);
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await rm(source, { recursive: true, force: true });
  }
});

test("a folder without .pi/agents offers nothing, and a linked .pi/agents is ignored", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-subagents-none-"));
  const plain = await mkdtemp(join(tmpdir(), "pi-web-subagents-plain-"));
  const linked = await mkdtemp(join(tmpdir(), "pi-web-subagents-linked-"));
  const outside = await mkdtemp(join(tmpdir(), "pi-web-subagents-outside-"));
  t.after(() => Promise.all([cwd, plain, linked, outside].map((dir) => rm(dir, { recursive: true, force: true }))));
  // A stray README must never look like an agent.
  writeFileSync(join(plain, "README.md"), "# notes\n");
  writeFileSync(join(outside, "leak.md"), "---\ndescription: Leak\n---\nLeak.\n");
  mkdirSync(join(linked, ".pi"), { recursive: true });
  await symlink(outside, join(linked, ".pi", "agents"));

  assert.deepEqual(listImportableAgentFiles(cwd, plain), []);
  assert.equal(countImportableAgentFiles(linked), 0);
  assert.deepEqual(importAgentProfiles(cwd, linked, "project", ["leak.md"]).imported, []);
});

test("project availability follows the effective definition, not display-name order", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-subagents-top-"));
  try {
    // A global copy that sorts after the built-in by display name and is switched off.
    saveSubagentProfile(cwd, "global", profile({ name: "explore", displayName: "Zzz explore", enabled: false }));
    setSubagentProjectAvailability(cwd, "explore", false);
    assert.equal(existsSync(join(cwd, ".pi", "agents", "explore.md")), false);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("a project copy of an inherited agent starts from its frontmatter, then stands on its own", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-subagents-copy-"));
  try {
    const globalDir = join(testAgentDir, "agents");
    mkdirSync(globalDir, { recursive: true });
    writeFileSync(join(globalDir, "shared.md"), "---\ndescription: Shared\nprompt_mode: replace\nowner: team\n---\nShared prompt.\n");

    saveSubagentProfile(cwd, "project", profile({ name: "shared", description: "Local" }));
    const projectPath = join(cwd, ".pi", "agents", "shared.md");
    let text = readFileSync(projectPath, "utf8");
    assert.match(text, /description: Local/);
    assert.match(text, /prompt_mode: replace/);
    assert.match(text, /owner: team/);

    // Once it exists it is its own source: a key removed by hand is not re-seeded.
    writeFileSync(projectPath, text.replace("owner: team\n", ""));
    saveSubagentProfile(cwd, "project", profile({ name: "shared", description: "Local 2" }));
    text = readFileSync(projectPath, "utf8");
    assert.doesNotMatch(text, /owner: team/);
    assert.match(text, /description: Local 2/);
    assert.equal(readFileSync(join(globalDir, "shared.md"), "utf8").includes("Shared prompt."), true);
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await rm(join(testAgentDir, "agents", "shared.md"), { force: true });
  }
});

test("deleting a project definition finds it by name even when the file name differs", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-subagents-del-"));
  try {
    const dir = join(cwd, ".pi", "agents");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "mine.md"), "---\nname: Reviewer\ndescription: Mine\n---\nMine.\n");
    deleteSubagentProfile(cwd, "project", "Reviewer");
    assert.equal(existsSync(join(dir, "mine.md")), false);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
