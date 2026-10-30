import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() } });
const { parseMcpPaste } = await jiti.import("./mcp-import.ts");
const { importSdkFile } = await jiti.import("./builtin-extensions.ts");
const { validateMcpServerConfig } = await importSdkFile("core/mcp-servers.js");
const { runMcpCommand } = await importSdkFile("extensions/mcp/cli.js");
const deps = { validateMcpServerConfig, runMcpCommand };
const parse = (text) => parseMcpPaste(text, deps);

function success(result) {
  assert.ok(!("error" in result), JSON.stringify(result));
  return result;
}

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "pi-web-mcp-import-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test("URL: derives a pi-safe hostname name and supplies http for localhost", async () => {
  assert.deepEqual(success(await parseMcpPaste("https://mcp.sentry.dev/mcp")), {
    servers: [{ name: "sentry", config: { url: "https://mcp.sentry.dev/mcp" } }], notes: [],
  });
  assert.deepEqual(success(await parse("localhost:3000/mcp")).servers, [
    { name: "localhost", config: { url: "http://localhost:3000/mcp" } },
  ]);
  assert.match(success(await parse("https://my.host.example/mcp")).servers[0].name, /^[A-Za-z0-9_-]+$/);
});

test("command: splits quotes and escapes, takes env prefixes, and never expands or executes", async (t) => {
  const root = fixture(t), marker = join(root, "never-run");
  const command = `TOKEN='!touch ${marker}' REF='\${TOKEN}' RAW=$TOKEN npx -y @modelcontextprotocol/server-filesystem '/a b' c\\ d "" "x\\qy" \\\n"$(touch ${marker})"`;
  assert.deepEqual(success(await parse(command)), {
    servers: [{ name: "filesystem", config: {
      command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "/a b", "c d", "", "x\\qy", `$(touch ${marker})`],
      env: { TOKEN: `!touch ${marker}`, REF: "${TOKEN}", RAW: "$TOKEN" },
    } }], notes: [],
  });
  for (const [text, name, executable, args] of [
    ["npx -y @scope/server-foo arg", "foo", "npx", ["-y", "@scope/server-foo", "arg"]],
    ["uvx foo", "foo", "uvx", ["foo"]],
    ["npx pi status", "pi", "npx", ["pi", "status"]],
    ["docker run --rm -i vendor/server-foo", "foo", "docker", ["run", "--rm", "-i", "vendor/server-foo"]],
  ]) {
    assert.deepEqual(success(await parse(text)).servers, [{ name, config: { command: executable, args } }]);
  }
  assert.equal(existsSync(marker), false);
  for (const invalid of ["npx 'unfinished", "uvx foo\\", "KEY=value"]) assert.ok("error" in await parse(invalid));
});

test("pi mcp add: uses the SDK grammar, including npx pi, headers, OAuth and literal values", async () => {
  const text = 'npx pi mcp add docs --url https://example.com/mcp --header "X-Token=$TOKEN" --bearer-token-env-var DOCS_TOKEN --oauth-client-secret "!printf secret" --description "Some docs"';
  assert.deepEqual(success(await parse(text)).servers, [{ name: "docs", config: {
    url: "https://example.com/mcp", headers: { "X-Token": "$TOKEN", Authorization: "Bearer ${DOCS_TOKEN}" },
    oauth: { clientSecret: "!printf secret" }, description: "Some docs",
  } }]);
});

test("Claude mcp add: maps transport, env, headers, scope and -- without eating command flags", async () => {
  assert.deepEqual(success(await parse('claude mcp add -s project -e TOKEN="a=b c" --env REF=\'${TOKEN}\' files -- npx -y @scope/server-filesystem --env literal')), {
    servers: [{ name: "files", config: { command: "npx", args: ["-y", "@scope/server-filesystem", "--env", "literal"], env: { TOKEN: "a=b c", REF: "${TOKEN}" } } }],
    notes: ["Claude's --scope is ignored; choose the scope below."],
  });
  assert.deepEqual(success(await parse('claude mcp add docs --transport http --header "Authorization: Bearer ${TOKEN}" -H "X-URL: https://example.com:123" https://example.com/mcp')).servers, [{
    name: "docs", config: { type: "http", url: "https://example.com/mcp", headers: { Authorization: "Bearer ${TOKEN}", "X-URL": "https://example.com:123" } },
  }]);
  for (const text of ["claude mcp add -e BAD x node", "claude mcp add -t", "claude mcp add --unknown foo node", "claude mcp add -t ws x url", 'claude mcp add -H "K: V" x node']) {
    assert.ok("error" in await parse(text), text);
  }
});

test("JSON: single entry, name map, mcpServers and VS Code; preserve fields and warn without executing", async (t) => {
  const root = fixture(t), marker = join(root, "never-run");
  const entry = {
    type: "stdio", command: "npx", args: ["-y", "@scope/server-foo", "${input:path}"],
    env: { A: "${env:TOKEN}", B: "$TOKEN", C: `!touch ${marker}` },
    extra: { keep: true }, exposure: "codemode-deferred",
  };
  for (const document of [entry, { foo: entry }, { mcpServers: { foo: entry } }, { servers: { foo: entry }, inputs: [{ id: "path", type: "promptString" }] }]) {
    const result = success(await parse(JSON.stringify(document)));
    assert.deepEqual(result.servers, [{ name: "foo", config: { ...entry, env: { ...entry.env, A: "${TOKEN}" } } }]);
    assert.equal(result.notes.length, 2);
    assert.match(result.notes.join("\n"), /runs a command when the server starts/);
    assert.match(result.notes.join("\n"), /replace VS Code.*\$\{NAME\}/);
  }
  for (const type of ["http", "streamable-http"]) {
    const config = { type, url: "https://mcp.sentry.dev/mcp", headers: { A: "!printf token" }, oauth: { clientSecret: "!printf secret" }, unknown: 123 };
    const result = success(await parse(JSON.stringify(config)));
    assert.deepEqual(result.servers, [{ name: "sentry", config }]);
    assert.equal(result.notes.length, 1);
  }
  assert.equal(existsSync(marker), false);
});

test("pi -l and --local keep BOTH paths inside one disposable dir and leave the real cwd untouched", async () => {
  const realPath = join(process.cwd(), ".pi", "mcp.json");
  const before = existsSync(realPath) ? readFileSync(realPath, "utf8") : null;
  for (const flag of ["-l", "--local"]) {
    let root;
    const result = await parseMcpPaste(`pi mcp add ${flag} local --env 'TOKEN=\${TOKEN}' -- npx -y @scope/server-foo`, {
      validateMcpServerConfig,
      runMcpCommand: async (args, options) => {
        root = dirname(options.cwd);
        assert.notEqual(options.cwd, process.cwd());
        assert.equal(dirname(options.agentDir), root);
        assert.ok(!relative(root, options.cwd).startsWith(".."));
        assert.deepEqual(args.slice(0, 2), ["add", flag]);
        const code = await runMcpCommand(args, options);
        assert.equal(existsSync(join(options.cwd, ".pi", "mcp.json")), true);
        return code;
      },
    });
    assert.deepEqual(success(result).servers, [{ name: "local", config: { command: "npx", args: ["-y", "@scope/server-foo"], env: { TOKEN: "${TOKEN}" } } }]);
    assert.equal(existsSync(root), false);
    assert.equal(existsSync(realPath) ? readFileSync(realPath, "utf8") : null, before);
  }
});

test("pi --help returns an error despite exit 0, and temp files are removed on every failure", async () => {
  let root;
  const capture = async (args, options) => { root = dirname(options.cwd); return runMcpCommand(args, options); };
  assert.match((await parseMcpPaste("pi mcp add --help", { ...deps, runMcpCommand: capture })).error, /did not create a server entry/);
  assert.equal(existsSync(root), false);
  assert.match((await parseMcpPaste("pi mcp add bad --unknown", { ...deps, runMcpCommand: capture })).error, /Unknown option --unknown/);
  assert.equal(existsSync(root), false);
  const failure = await parseMcpPaste("pi mcp add bad -- node", { ...deps, runMcpCommand: async (_, options) => {
    root = dirname(options.cwd);
    throw new Error("SDK failed");
  } });
  assert.equal(failure.error, "SDK failed");
  assert.equal(existsSync(root), false);
});

test("SSE is rejected with migration advice in Claude commands and JSON", async () => {
  for (const text of ['claude mcp add -t sse old https://example.com/sse', '{"old":{"type":"sse","url":"https://example.com/sse"}}']) {
    const result = await parse(text);
    assert.match(result.error, /streamable HTTP/);
    assert.match(result.error, /\/mcp instead of \/sse/);
  }
});

test("multi-server JSON validates every entry, skips invalid entries in notes, and keeps unknown keys", async () => {
  const good = { command: "node", extra: ["preserved"] };
  const map = { good, invalid: { command: "node", args: "bad" }, old: { type: "sse", url: "https://example.com/sse" }, "bad name": good, notObject: null };
  const calls = [];
  const result = success(await parseMcpPaste(JSON.stringify({ mcpServers: map }), {
    validateMcpServerConfig: (name, config) => { calls.push(name); return validateMcpServerConfig(name, config); },
  }));
  assert.deepEqual(calls, Object.keys(map));
  assert.deepEqual(result.servers, [{ name: "good", config: good }]);
  assert.equal(result.notes.length, 4);
  assert.ok(result.notes.includes(validateMcpServerConfig("invalid", map.invalid)));
  assert.match(result.notes.join("\n"), /bad name/);
  assert.match(result.notes.join("\n"), /notObject/);
  for (const text of ["", "{}", "[]", "{bad json", '{"command":42}', '{"url":"ftp://example.com"}']) assert.ok("error" in await parse(text), text);
});

test("POST import guards origin and JSON content, bounds streamed bytes, and validates text", async () => {
  const { POST } = await jiti.import("../app/api/mcp/import/route.ts");
  const request = (body, headers = {}) => new Request("http://localhost/api/mcp/import", {
    method: "POST", headers: { host: "localhost", "content-type": "application/json", ...headers }, body,
  });
  assert.equal((await POST(request('{"text":"uvx foo"}', { origin: "https://evil.example" }))).status, 403);
  assert.equal((await POST(request('{"text":"uvx foo"}', { host: "evil.example" }))).status, 403);
  assert.equal((await POST(request('{}', { "content-type": "text/plain" }))).status, 415);
  for (const body of ["{", "null", "[]", "{}", '{"text":1}']) assert.equal((await POST(request(body))).status, 400);
  assert.equal((await POST(request(JSON.stringify({ text: "é".repeat(128 * 1024) })))).status, 413);
  const streamed = new Request("http://localhost/api/mcp/import", {
    method: "POST", headers: { host: "localhost", "content-type": "application/json", "content-length": "1" }, duplex: "half",
    body: new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(256 * 1024)); controller.enqueue(new Uint8Array(1)); controller.close(); } }),
  });
  assert.equal((await POST(streamed)).status, 413);
  const result = await POST(request('{"text":"https://mcp.sentry.dev/mcp"}'));
  assert.equal(result.status, 200);
  assert.deepEqual((await result.json()).servers, [{ name: "sentry", config: { url: "https://mcp.sentry.dev/mcp" } }]);
});
