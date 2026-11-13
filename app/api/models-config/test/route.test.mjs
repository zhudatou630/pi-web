import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";

const agentDir = await mkdtemp(join(tmpdir(), "pi-web-model-test-route-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;

// Stand-in for the provider endpoint. OpenCode's gateway answers 400 MissingSessionID when
// x-opencode-session is absent, so the probe must carry one.
const requests = [];
const server = createServer((req, res) => {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    requests.push({ session: req.headers["x-opencode-session"], stream: body.stream === true, authorization: req.headers.authorization, custom: req.headers["x-custom"] });
    // Same rejection OpenCode's gateway returns for an unrouted probe.
    if (!req.headers["x-opencode-session"]) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        type: "error",
        error: { type: "MissingSessionID", message: "Request is missing x-opencode-session and cannot be routed efficiently." },
      }));
      return;
    }
    const base = { id: "chatcmpl-test", object: "chat.completion", created: 0, model: "test-model" };
    if (body.stream !== true) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        ...base,
        choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "OK" } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }));
      return;
    }
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
    const send = (payload) => res.write(`data: ${JSON.stringify({ ...base, object: "chat.completion.chunk", ...payload })}\n\n`);
    send({ choices: [{ index: 0, delta: { role: "assistant", content: "OK" }, finish_reason: null }] });
    send({
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
    res.write("data: [DONE]\n\n");
    res.end();
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

after(async () => {
  server.close();
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  await rm(agentDir, { recursive: true, force: true });
});

const { POST } = await createJiti(import.meta.url, { tsconfigPaths: true }).import("./route.ts");
const port = server.address().port;

const probe = (providerName, provider = {}) => POST(new Request("http://localhost/api/models-config/test", {
  method: "POST",
  headers: { "Content-Type": "application/json", host: "localhost" },
  body: JSON.stringify({
    providerName,
    provider: { baseUrl: `http://127.0.0.1:${port}/v1`, api: "openai-completions", apiKey: "test-key", ...provider },
    model: { id: "test-model", api: "openai-completions", input: ["text"], contextWindow: 8192, maxTokens: 1024 },
  }),
}));

test("an opencode probe sends a routing session id and succeeds", async () => {
  requests.length = 0;
  const response = await probe("opencode-go");
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.ok, true, body.error);
  assert.equal(requests.length, 1);
  assert.match(requests[0].session ?? "", /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
});

test("each probe uses its own throwaway routing id", async () => {
  requests.length = 0;
  await probe("opencode-go");
  await probe("opencode-go");

  assert.equal(requests.length, 2);
  assert.ok(requests[0].session);
  assert.notEqual(requests[0].session, requests[1].session);
});

test("a custom OpenCode URL uses runtime auth and session preparation", async (t) => {
  const seen = [];
  const fetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (input, init) => {
    const request = new Request(input, init);
    if (request.url.startsWith("https://opencode.ai/")) {
      seen.push(request);
      return fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: request.method, headers: request.headers, body: await request.text() });
    }
    return fetch(input, init);
  });
  const response = await probe("custom-gateway", { baseUrl: "https://opencode.ai/zen/go/v1", headers: { "X-Custom": "draft-header" } });
  const body = await response.json();
  assert.equal(body.ok, true, body.error);
  assert.equal(body.responseText, "OK");
  assert.equal(seen.length, 1);
  assert.equal(seen[0].headers.get("authorization"), "Bearer test-key");
  assert.equal(seen[0].headers.get("x-custom"), "draft-header");
  assert.match(seen[0].headers.get("x-opencode-session") ?? "", /^[0-9a-f-]{36}$/);
});

test("the probe executes a command key exactly once", { skip: process.platform === "win32" }, async () => {
  const counter = join(agentDir, "command-runs");
  const response = await probe("opencode-go", { apiKey: `!printf x >> '${counter}'; printf test-key` });
  const body = await response.json();
  assert.equal(body.ok, true, body.error);
  assert.equal(await readFile(counter, "utf8"), "x");
});
