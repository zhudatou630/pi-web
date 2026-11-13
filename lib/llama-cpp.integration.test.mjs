import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";

const root = await mkdtemp(join(tmpdir(), "pi-llama-"));
const agentDir = join(root, "agent");
const cwd = join(root, "project");
await Promise.all([mkdir(agentDir), mkdir(cwd)]);
const previous = process.env.PI_CODING_AGENT_DIR;
const offline = process.env.PI_OFFLINE;
const llamaEnv = { LLAMA_BASE_URL: process.env.LLAMA_BASE_URL, LLAMA_API_KEY: process.env.LLAMA_API_KEY };
delete process.env.LLAMA_BASE_URL;
delete process.env.LLAMA_API_KEY;
process.env.PI_CODING_AGENT_DIR = agentDir;
delete process.env.PI_OFFLINE;
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { POST, DELETE } = await jiti.import("../app/api/auth/api-key/[provider]/route.ts");
const { POST: testModel } = await jiti.import("../app/api/models-config/test/route.ts");
const { GET: models } = await jiti.import("../app/api/models/route.ts");
const { GET: authProviders } = await jiti.import("../app/api/auth/providers/route.ts");
const { createModelsConfigServices } = await jiti.import("./model-config-services.ts");
const { allowFileRoot } = await jiti.import("./file-access.ts");
allowFileRoot(cwd);
after(async () => {
  if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previous;
  if (offline === undefined) delete process.env.PI_OFFLINE;
  else process.env.PI_OFFLINE = offline;
  for (const [name, value] of Object.entries(llamaEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  delete globalThis.__piModelsConfigReadServices;
  await rm(root, { recursive: true, force: true });
});
const context = { params: Promise.resolve({ provider: "llama.cpp" }) };
const request = body => new Request("http://localhost/api/auth/api-key/llama.cpp", {
  method: "POST", headers: { Host: "localhost", "Content-Type": "application/json" }, body: JSON.stringify({ cwd, ...body }),
});
const catalog = [
  { id: "chat", status: { value: "loaded" }, architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] }, meta: { n_ctx: 32768 } },
  { id: "sleeping", status: { value: "sleeping" } },
  { id: "autoload", status: { value: "unloaded" }, source: "preset" },
  { id: "classifier", status: { value: "loaded" }, architecture: { output_modalities: ["decisions"] } },
  { id: "unavailable", status: { value: "unloaded" } },
];

test("llama.cpp validates URLs while other providers still require a key", async () => {
  for (const serverUrl of [undefined, "file:///tmp/test", "not-a-url", "https://user:key@router.test"]) {
    assert.equal((await POST(request({ serverUrl }), context)).status, 400);
  }
  assert.equal((await POST(request({ apiKey: "" }), { params: Promise.resolve({ provider: "openai" }) })).status, 400);
  assert.equal((await POST(request({ serverUrl: "http://router.test", apiKey: 123 }), context)).status, 400);
});

test("URL + optional key uses SDK login, refreshes the router and restores chat-only catalog data offline", async (t) => {
  const requests = [];
  t.mock.method(globalThis, "fetch", async (input, init) => {
    const req = new Request(input, init);
    requests.push(req);
    assert.equal(new URL(req.url).origin, "http://router.test");
    return Response.json(new URL(req.url).pathname === "/models" ? { data: catalog } : { models_autoload: true, chat_template: "enable_thinking" });
  });
  const listing = await (await authProviders(new Request(`http://localhost/api/auth/providers?cwd=${encodeURIComponent(cwd)}`))).json();
  assert.ok(listing.apiKeyProviders.some(provider => provider.id === "llama.cpp" && !provider.configured));
  for (const key of ["", "secret-test-key"]) {
    requests.length = 0;
    const response = await POST(request({ serverUrl: "http://router.test/v1/", apiKey: key }), context);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.success, true, body.error);
    assert.equal(body.catalog.completed, true);
    assert.equal(body.catalog.modelCount, 3);
    assert.ok(requests.length >= 2, "login validates and post-save catalog refresh fetches");
    assert.equal(requests[0].headers.get("authorization"), key ? `Bearer ${key}` : null);
    assert.ok(requests.slice(1).every(req => req.headers.get("authorization") === `Bearer ${key || "local"}`), "runtime uses pi's local placeholder for keyless auth");
    assert.ok(requests.every(req => !req.url.includes("autoload=true")), "reading props must not load a model");
    const credential = JSON.parse(await readFile(join(agentDir, "auth.json"), "utf8"))["llama.cpp"];
    assert.equal(credential.type, "api_key");
    assert.equal(credential.env.LLAMA_BASE_URL, "http://router.test");
    const count = requests.length;
    const runtime = (await createModelsConfigServices(cwd)).modelRuntime;
    assert.deepEqual(runtime.getModels("llama.cpp").map(model => model.id), ["chat", "sleeping", "autoload"]);
    assert.ok(runtime.getModelsOfType("classifier", "llama.cpp").some(model => model.id === "classifier"));
    const reply = await (await models(new Request(`http://localhost/api/models?cwd=${encodeURIComponent(cwd)}`))).json();
    assert.equal(reply.providerNames["llama.cpp"], "llama.cpp");
    assert.deepEqual(reply.modelList.filter(model => model.provider === "llama.cpp").map(model => model.id), ["chat", "sleeping", "autoload"]);
    assert.equal(JSON.stringify(reply).includes("secret-test-key"), false);
    assert.equal(requests.length, count, "listing and config reads restore the catalog without network");
    const { startRpcSession } = await jiti.import("./rpc-manager.ts");
    const { session } = await startRpcSession(`__new__llama-${key ? "key" : "local"}`, "", cwd, {
      initialModel: { provider: "llama.cpp", modelId: "chat" }, persistStartupPreferences: false, toolNames: ["read"],
    });
    try {
      assert.equal(session.inner.model.provider, "llama.cpp");
      assert.equal(session.inner.model.id, "chat");
      const auth = await session.inner.modelRuntime.getAuth(session.inner.model);
      assert.equal(auth.auth.baseUrl, "http://router.test/v1");
      assert.equal(auth.auth.apiKey, key || "local");
    } finally {
      await session.shutdown();
    }
  }
});

test("a keyless llama.cpp connection can test a draft model without rewriting saved definitions", async (t) => {
  const completions = [];
  t.mock.method(globalThis, "fetch", async (input, init) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    assert.equal(url.origin, "http://router.test");
    if (url.pathname === "/models") return Response.json({ data: catalog });
    if (url.pathname === "/props") return Response.json({ models_autoload: true });
    assert.equal(url.pathname, "/v1/chat/completions");
    completions.push({ headers: req.headers, body: await req.json() });
    return new Response(`data: ${JSON.stringify({ id: "probe", object: "chat.completion.chunk", created: 0, model: "chat", choices: [{ index: 0, delta: { role: "assistant", content: "OK" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`, { headers: { "Content-Type": "text/event-stream" } });
  });
  const connected = await (await POST(request({ serverUrl: "http://router.test", apiKey: "" }), context)).json();
  assert.equal(connected.success, true, connected.error);
  const saved = JSON.stringify({ providers: { "llama.cpp": { modelOverrides: { chat: { samplingParams: { temperature: 0.9 } } } } } });
  const modelsPath = join(agentDir, "models.json");
  await writeFile(modelsPath, saved);
  t.after(() => rm(modelsPath, { force: true }));
  const response = await testModel(new Request("http://localhost/api/models-config/test", {
    method: "POST", headers: { Host: "localhost", "Content-Type": "application/json" },
    body: JSON.stringify({ cwd, providerName: "llama.cpp", provider: {}, model: {
      id: "chat", samplingParams: { temperature: 0.25 },
    } }),
  }));
  const result = await response.json();
  assert.equal(result.ok, true, result.error);
  assert.equal(result.responseText, "OK");
  assert.equal(completions.length, 1);
  assert.equal(completions[0].headers.get("authorization"), "Bearer local");
  assert.equal(completions[0].body.temperature, 0.25, "the isolated draft wins over saved overrides");
  assert.equal(await readFile(modelsPath, "utf8"), saved);
});

test("empty catalogs and refresh failure keep saved credentials and can be retried", async (t) => {
  let lists = 0;
  t.mock.method(globalThis, "fetch", async (input) => {
    if (String(input).endsWith("/models") && ++lists > 1) throw new Error("refresh failed");
    return Response.json({ data: [] });
  });
  let body = await (await POST(request({ serverUrl: "http://router.test", apiKey: "" }), context)).json();
  assert.equal(body.success, true);
  assert.equal(body.catalog.completed, false);
  assert.ok(JSON.parse(await readFile(join(agentDir, "auth.json"), "utf8"))["llama.cpp"]);
  t.mock.method(globalThis, "fetch", async () => Response.json({ data: [] }));
  body = await (await POST(request({ serverUrl: "http://router.test", apiKey: "" }), context)).json();
  assert.equal(body.catalog.completed, true);
  assert.equal(body.catalog.modelCount, 0);
  assert.equal((await DELETE(request({}), context)).status, 200);
});

test("only normal sessions load the llama provider; Chat only and sub-agents keep extension-free creation", async () => {
  const { createBuiltinExtensions } = await jiti.import("./builtin-extensions.ts");
  const extensions = await createBuiltinExtensions();
  const llama = extensions.find(extension => extension.name === "llama.cpp");
  let provider;
  await llama.factory({ registerProvider(value) { provider = value; } });
  assert.equal(provider.id, "llama.cpp");
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ extensions: ["-builtin:llama.cpp"] }));
  assert.equal((await createModelsConfigServices(cwd)).modelRuntime.getProvider("llama.cpp"), undefined);
  const rpc = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  assert.match(rpc, /resourceLoaderOptions: subagentResources\s*\?/);
  assert.match(rpc, /: chatOnly\s*\? \{\s*noExtensions: true/);
  assert.match(rpc, /extensionFactories: \[\s*\/\/[^\n]*sub-agents[^\n]*\n\s*\.\.\.\(await createBuiltinExtensions\(\)\)/);
});
