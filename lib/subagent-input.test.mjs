import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const {
  appendSubagentInputFiles,
  loadSubagentInputFiles,
  MAX_SUBAGENT_INPUT_BYTES,
  MAX_SUBAGENT_INPUT_FILES,
  subagentInputByteLimit,
} = await createJiti(import.meta.url).import("./subagent-input.ts");

test("checks cumulative stat sizes before reading, then checks actual bytes for growth", async (t) => {
  const require = createRequire(import.meta.url);
  const jiti = createJiti(import.meta.url);
  const security = await jiti.import("./path-security.ts");
  const paths = await jiti.import("./paths.ts");
  const { outputText } = ts.transpileModule(fs.readFileSync(new URL("./subagent-input.ts", import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS },
  });
  const exports = {};
  runInNewContext(outputText, { exports, TextDecoder, require(id) {
    if (id === "./path-security") return security;
    if (id === "./paths") return paths;
    return require(id);
  } });
  const { loadSubagentInputFiles } = exports;
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-subagent-input-size-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await writeFile(join(cwd, "a.txt"), "1234");
  await writeFile(join(cwd, "b.txt"), "5678");
  const read = fs.readFileSync;
  const reads = [];
  const mock = t.mock.method(fs, "readFileSync", (path, ...args) => {
    reads.push(path);
    return read(path, ...args);
  });
  assert.throws(() => loadSubagentInputFiles(cwd, ["a.txt", "b.txt"], 7), /7-byte total limit/);
  assert.deepEqual(reads, [join(cwd, "a.txt")]);
  reads.length = 0;
  assert.throws(() => loadSubagentInputFiles(cwd, ["a.txt"], 3), /3-byte total limit/);
  assert.deepEqual(reads, []);
  mock.mock.restore();
  t.mock.method(fs, "readFileSync", () => Buffer.from("grew after stat"));
  assert.throws(() => loadSubagentInputFiles(cwd, ["a.txt"], 4), /4-byte total limit/);
});

test("loads cwd-relative UTF-8 files and formats them as delegated user input", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-subagent-input-"));
  try {
    await mkdir(join(cwd, "docs"));
    await writeFile(join(cwd, "docs", "article.md"), "# Article\n\nEvidence.", "utf8");

    const files = loadSubagentInputFiles(cwd, ["docs/article.md"]);
    assert.deepEqual(files, [{ path: "docs/article.md", content: "# Article\n\nEvidence." }]);
    assert.equal(
      appendSubagentInputFiles("Analyze the argument.", files),
      "Analyze the argument.\n\n<documents>\n<document path=\"docs/article.md\">\n# Article\n\nEvidence.\n</document>\n</documents>",
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("rejects files outside cwd, including symlink targets", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-subagent-input-cwd-"));
  const outside = await mkdtemp(join(tmpdir(), "pi-web-subagent-input-outside-"));
  try {
    const outsideFile = join(outside, "article.md");
    await writeFile(outsideFile, "Private", "utf8");
    await symlink(outsideFile, join(cwd, "linked.md"));

    assert.throws(() => loadSubagentInputFiles(cwd, [outsideFile]), /outside the session cwd/);
    assert.throws(() => loadSubagentInputFiles(cwd, ["linked.md"]), /outside the session cwd/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("rejects invalid UTF-8 and bounded input sets", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-subagent-input-"));
  try {
    await writeFile(join(cwd, "binary.txt"), Buffer.from([0xc3, 0x28]));
    await writeFile(join(cwd, "large.txt"), "x".repeat(MAX_SUBAGENT_INPUT_BYTES + 1), "utf8");

    assert.throws(() => loadSubagentInputFiles(cwd, ["binary.txt"]), /not valid UTF-8/);
    assert.throws(() => loadSubagentInputFiles(cwd, ["large.txt"]), /total limit/);
    assert.throws(
      () => loadSubagentInputFiles(cwd, Array(MAX_SUBAGENT_INPUT_FILES + 1).fill("binary.txt")),
      /at most/,
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("the input limit follows the child model's context window, capped at the flat limit", async () => {
  assert.equal(subagentInputByteLimit(undefined), MAX_SUBAGENT_INPUT_BYTES);
  assert.equal(subagentInputByteLimit({ contextWindow: 0 }), MAX_SUBAGENT_INPUT_BYTES);
  assert.equal(subagentInputByteLimit({ contextWindow: 200_000 }), 200_000);
  assert.equal(subagentInputByteLimit({ contextWindow: 1_000_000 }), MAX_SUBAGENT_INPUT_BYTES);

  const cwd = await mkdtemp(join(tmpdir(), "pi-web-subagent-input-"));
  try {
    await writeFile(join(cwd, "a.txt"), "x".repeat(101), "utf8");
    assert.throws(() => loadSubagentInputFiles(cwd, ["a.txt"], 100), /100-byte total limit/);
    assert.equal(loadSubagentInputFiles(cwd, ["a.txt"], 101).length, 1);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
