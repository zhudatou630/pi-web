import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });

async function withAgentDir(run) {
  const dir = mkdtempSync(join(tmpdir(), "pi-web-manifest-"));
  const saved = { agentDir: process.env.PI_CODING_AGENT_DIR, appName: process.env.PI_WEB_APP_NAME };
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    await run(dir);
  } finally {
    for (const [key, value] of [["PI_CODING_AGENT_DIR", saved.agentDir], ["PI_WEB_APP_NAME", saved.appName]]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

test("manifest reads the app name at runtime without changing other metadata", async () => {
  const { default: manifest, dynamic } = await jiti.import("./manifest.ts");
  await withAgentDir(async () => {
    assert.equal(dynamic, "force-dynamic");
    delete process.env.PI_WEB_APP_NAME;
    const defaults = manifest();
    assert.equal(defaults.name, "Pi Web");
    assert.equal(defaults.short_name, "Pi Web");

    // Reuse the same imported function: the environment must not be captured at load time.
    for (const [value, expected] of [
      ["", "Pi Web"],
      [" \t\n ", "Pi Web"],
      ["Work Pi", "Work Pi"],
      ["  工作 Pi 🚀 \n", "工作 Pi 🚀"],
    ]) {
      process.env.PI_WEB_APP_NAME = value;
      assert.deepEqual(manifest(), { ...defaults, name: expected, short_name: expected });
    }
  });
});

test("manifest follows the saved app identity over PI_WEB_APP_NAME", async () => {
  const { default: manifest } = await jiti.import("./manifest.ts");
  const { writeAppIdentity } = await jiti.import("../lib/app-identity.ts");
  await withAgentDir(async () => {
    process.env.PI_WEB_APP_NAME = "From env";
    assert.match(manifest().icons[0].src, /^\/icons\/icon-192\.png/);

    writeAppIdentity({ name: "", color: "default" });
    assert.equal(manifest().name, "From env");

    writeAppIdentity({ name: "Home", color: "blue" });
    const custom = manifest();
    assert.equal(custom.name, "Home");
    assert.deepEqual(custom.icons.map((icon) => icon.src.replace(/\?v=\w+$/, "")), ["/app-icons/192.png", "/app-icons/512.png"]);
  });
});

test("install metadata is never streamed into <body>", async () => {
  // Async generateMetadata streams by default; Safari reads the manifest and touch icon only from <head>.
  const { readFile } = await import("node:fs/promises");
  const config = await readFile(new URL("../next.config.ts", import.meta.url), "utf8");
  assert.match(config, /htmlLimitedBots: \/\.\*\//);
});
