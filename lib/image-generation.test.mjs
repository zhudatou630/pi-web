import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4AWLSyF/8HwAAAP//Cphv1wAAAAZJREFUAwAEQQI8VQEFywAAAABJRU5ErkJggg==", "base64");
const jiti = createJiti(import.meta.url);
const { createImageGenerationExtension, HOST_IMAGE_EXTENSION_PATH, preferPiWebImageTool } = await jiti.import("./image-generation-extension.ts");
const { extractMentionedImagePath, getImageGenerationResult, imageToolDisplayKind, splitImageMentions, imageAspectOptions, imageRatioKind, sizeForImageAspect, xaiAspectRatio } = await jiti.import("./image-generation.ts");

function captureTool(agentDir) {
  let tool;
  createImageGenerationExtension(agentDir).factory({ registerTool(value) { tool = value; } });
  return tool;
}

function imageConfig(connection = {}) {
  return { connections: { studio: {
    provider: "xai",
    model: "grok-imagine-image-2.0",
    capabilities: { editing: true, sizes: ["auto", "1:1", "2:3", "16:9"], resolutions: ["1k", "2k"], qualities: ["medium"] },
    ...connection,
  } } };
}

function requestBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.once("end", () => resolve(Buffer.concat(chunks)));
    request.once("error", reject);
  });
}

test("mentioned image paths come from @ tokens in the user message", () => {
  assert.equal(extractMentionedImagePath("改姿势"), undefined);
  assert.equal(extractMentionedImagePath("@.pi/generated-images/image.jpg 改姿势"), ".pi/generated-images/image.jpg");
  assert.equal(extractMentionedImagePath("先看 @readme.md 再改 @\"folder/old.png\""), "folder/old.png");
  assert.deepEqual(splitImageMentions("@.pi/generated-images/image.jpg 改姿势"), [
    { type: "mention", path: ".pi/generated-images/image.jpg" },
    { type: "text", value: " 改姿势" },
  ]);
  assert.equal(imageToolDisplayKind("generate_image", { target: "a.jpg" }), "edit");
  assert.equal(imageToolDisplayKind("generate_image", { new_image: true }), "generate");
  assert.equal(imageToolDisplayKind("read"), null);
});

test("declared sizes map to the first matching square, portrait, or landscape option", () => {
  assert.deepEqual(imageAspectOptions(["1024x1536", "1024x1024", "1536x1024", "512x512"]), [
    { aspect: "portrait", size: "1024x1536" },
    { aspect: "square", size: "1024x1024" },
    { aspect: "landscape", size: "1536x1024" },
  ]);
  assert.deepEqual(imageAspectOptions(["1:1", "2:3", "16:9"]), [
    { aspect: "square", size: "1:1" },
    { aspect: "portrait", size: "2:3" },
    { aspect: "landscape", size: "16:9" },
  ]);
  assert.equal(sizeForImageAspect(["1024x1536"], "portrait"), "1024x1536");
  assert.equal(sizeForImageAspect(["1024x1536"], "landscape"), undefined);
  assert.equal(xaiAspectRatio("1024x1024"), "1:1");
  assert.equal(xaiAspectRatio("1024x1536"), "2:3");
  assert.equal(xaiAspectRatio("1:1"), "1:1");
  assert.equal(xaiAspectRatio("auto"), "auto");
  assert.equal(xaiAspectRatio("9:16"), "9:16");
  assert.equal(xaiAspectRatio(), undefined);
  assert.equal(imageRatioKind("auto"), "auto");
  assert.equal(imageRatioKind("9:16"), "portrait");
});

test("package generate_image yields to the pi-web image extension", () => {
  const other = { path: "/pkg/pi-antigravity", tools: new Map([["generate_image", { definition: { name: "generate_image" } }]]) };
  const host = { path: HOST_IMAGE_EXTENSION_PATH, tools: new Map([["generate_image", { definition: { name: "generate_image" } }]]) };
  const next = preferPiWebImageTool({ extensions: [other, host], errors: [] });
  assert.equal(next.extensions[0].tools.has("generate_image"), false);
  assert.equal(next.extensions[1].tools.has("generate_image"), true);
});

test("the extension stays absent until images.json exists", () => {
  const agentDir = mkdtempSync(path.join(tmpdir(), "pi-image-agent-"));
  try {
    assert.equal(captureTool(agentDir), undefined);
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("the standard tool generates xAI images and rejects editing or other providers", { timeout: 15_000 }, async () => {
  const root = mkdtempSync(path.join(tmpdir(), "pi-image-tool-"));
  const agentDir = path.join(root, "agent");
  const cwd = path.join(root, "project");
  mkdirSync(agentDir);
  mkdirSync(cwd);
  const calls = [];
  let errorResponse = false;
  const server = createServer(async (request, response) => {
    calls.push({ url: request.url, headers: request.headers, contentType: request.headers["content-type"], body: await requestBody(request) });
    if (errorResponse) {
      response.writeHead(400, { "Content-Type": "application/json", "X-Request-Id": "image-request-1" });
      return response.end(JSON.stringify({ error: { message: "unsupported size", code: "invalid_size" } }));
    }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ data: [{ b64_json: PNG.toString("base64") }] }));
  });

  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    writeFileSync(path.join(agentDir, "images.json"), JSON.stringify({
      default: "studio",
      connections: {
        studio: {
          provider: "xai",
          model: "grok-imagine-image-2.0",
          capabilities: { editing: true, sizes: ["auto", "1:1", "9:16", "16:9"], resolutions: ["1k", "2k"], qualities: ["auto", "medium"] },
          defaults: { size: "auto", resolution: "1k", quality: "medium" },
        },
        flare: { provider: "sub2api", model: "gpt-image-2.5-flare" },
      },
    }));
    const tool = captureTool(agentDir);
    assert.ok(tool);
    const context = {
      cwd,
      sessionManager: { getBranch: () => [] },
      modelRegistry: {
        getProviderAuth: async () => ({ auth: { headers: { "X-Image-Auth": "fixture-token" } } }),
        getProvider: () => ({ baseUrl: `http://127.0.0.1:${address.port}/v1` }),
      },
    };

    await assert.rejects(
      tool.execute("unsupported", { prompt: "wrong size", size: "2048x2048" }, undefined, undefined, context),
      /does not support size 2048x2048/,
    );
    await assert.rejects(
      tool.execute("resolution", { prompt: "too sharp", resolution: "4k" }, undefined, undefined, context),
      /does not support resolution 4k/,
    );
    await assert.rejects(
      tool.execute("proxy", { prompt: "via sub2api", connection: "flare" }, undefined, undefined, context),
      /only xai is supported/,
    );
    await assert.rejects(
      tool.execute("missing-attachment", { prompt: "make it red", use_last_attachment: true }, undefined, undefined, context),
      /No image attachment/,
    );
    assert.equal(calls.length, 0);

    const generated = await tool.execute("generate", { prompt: "a blue square", size: "1:1", resolution: "2k" }, undefined, undefined, context);
    assert.equal(calls[0].url, "/v1/images/generations");
    assert.match(calls[0].contentType, /^application\/json/);
    assert.deepEqual(JSON.parse(calls[0].body.toString()), {
      model: "grok-imagine-image-2.0",
      prompt: "a blue square",
      n: 1,
      response_format: "b64_json",
      aspect_ratio: "1:1",
      resolution: "2k",
      quality: "medium",
    });
    const details = getImageGenerationResult(generated.details);
    assert.ok(details);
    assert.equal(details.path.startsWith(".pi/generated-images/"), true);
    assert.deepEqual(readFileSync(path.join(cwd, details.path)), PNG);
    assert.equal(details.connection, "studio");
    assert.equal(details.model, "grok-imagine-image-2.0");
    assert.equal(details.size, "1:1");
    assert.equal(details.resolution, "2k");

    const sourceDir = path.join(cwd, ".pi", "generated-images");
    mkdirSync(sourceDir, { recursive: true });
    const sourcePath = path.join(sourceDir, "source.png");
    writeFileSync(sourcePath, PNG);
    const edited = await tool.execute("edit", { prompt: "make it red", target: ".pi/generated-images/source.png" }, undefined, undefined, context);
    assert.equal(calls[1].url, "/v1/images/edits");
    const editedBody = JSON.parse(calls[1].body.toString());
    assert.equal(editedBody.prompt, "make it red");
    assert.equal(editedBody.image.type, "image_url");
    assert.match(editedBody.image.url, /^data:image\/png;base64,/);
    assert.equal(editedBody.aspect_ratio, undefined);
    assert.ok(getImageGenerationResult(edited.details));

    context.sessionManager.getBranch = () => [{
      type: "custom_message",
      details: generated.details,
    }];
    await tool.execute("last", { prompt: "warmer light" }, undefined, undefined, context);
    assert.equal(calls[2].url, "/v1/images/edits");

    context.sessionManager.getBranch = () => [
      { type: "custom_message", details: generated.details },
      { type: "message", message: { role: "user", content: "@.pi/generated-images/missing.png 改姿势" } },
    ];
    await assert.rejects(
      tool.execute("mentioned", { prompt: "改姿势" }, undefined, undefined, context),
      /Image path is not a file|no such file/i,
    );
    context.sessionManager.getBranch = () => [
      { type: "custom_message", details: generated.details },
      { type: "message", message: { role: "user", content: "@.pi/generated-images/source.png 改姿势" } },
    ];
    await tool.execute("mentioned-source", { prompt: "改姿势" }, undefined, undefined, context);
    assert.equal(calls[3].url, "/v1/images/edits");

    context.sessionManager.getBranch = () => [
      { type: "custom_message", details: generated.details },
      {
        type: "message",
        message: {
          role: "user",
          content: [
            { type: "image", data: PNG.toString("base64"), mimeType: "image/png" },
            { type: "text", text: "改成油画" },
          ],
        },
      },
    ];
    await tool.execute("from-attachment", { prompt: "改成油画" }, undefined, undefined, context);
    assert.equal(calls[4].url, "/v1/images/edits");

    context.sessionManager.getBranch = () => [{ type: "custom_message", details: generated.details }];
    await tool.execute("fresh", { prompt: "a cat", new_image: true }, undefined, undefined, context);
    assert.equal(calls[5].url, "/v1/images/generations");

    await tool.execute("provider", { prompt: "reuse provider auth", new_image: true }, undefined, undefined, context);
    assert.equal(calls[6].headers["x-image-auth"], "fixture-token");

    errorResponse = true;
    await assert.rejects(
      tool.execute("error", { prompt: "show the error" }, undefined, undefined, context),
      /HTTP 400: unsupported size; invalid_size \(request image-request-1\)/,
    );
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
});

test("image paths cannot escape the current working directory", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "pi-image-path-"));
  const agentDir = path.join(root, "agent");
  const cwd = path.join(root, "project");
  const outside = path.join(root, "outside.png");
  mkdirSync(agentDir);
  mkdirSync(cwd);
  writeFileSync(outside, PNG);
  writeFileSync(path.join(agentDir, "images.json"), JSON.stringify(imageConfig()));
  try {
    const tool = captureTool(agentDir);
    await assert.rejects(
      tool.execute("escape", { prompt: "upload it", target: outside }, undefined, undefined, {
        cwd,
        sessionManager: { getBranch: () => [] },
        modelRegistry: {
          getProviderAuth: async () => ({ auth: { apiKey: "fixture-key" } }),
          getProvider: () => ({ baseUrl: "http://127.0.0.1:1/v1" }),
        },
      }),
      /outside the working directory/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("normal RPC sessions activate the configured image extension", { timeout: 15_000 }, async () => {
  const root = mkdtempSync(path.join(tmpdir(), "pi-image-session-"));
  const agentDir = path.join(root, "agent");
  const cwd = path.join(root, "project");
  mkdirSync(agentDir);
  mkdirSync(cwd);
  let holdNextRequest = false;
  let requestCount = 0;
  let markHeldRequestStarted;
  let releaseHeldRequest;
  const server = createServer(async (request, response) => {
    requestCount++;
    await requestBody(request);
    if (holdNextRequest) {
      markHeldRequestStarted?.();
      await new Promise((resolve) => { releaseHeldRequest = resolve; });
    }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ data: [{ b64_json: PNG.toString("base64") }] }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  writeFileSync(path.join(agentDir, "images.json"), JSON.stringify(imageConfig()));
  writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({ providers: { xai: {
    baseUrl: `http://127.0.0.1:${address.port}/v1`, api: "openai-completions", apiKey: "key", models: [{
      id: "fixture-chat", name: "Fixture", reasoning: false, input: ["text", "image"], contextWindow: 100000, maxTokens: 1000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }],
  } } }));
  writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({
    defaultProvider: "xai", defaultModel: "fixture-chat", enabledModels: ["xai/fixture-chat"], enableInstallTelemetry: false,
  }));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  let wrapper;
  let chatOnlyWrapper;
  try {
    const rpc = await createJiti(import.meta.url, { moduleCache: false }).import("./rpc-manager.ts");
    wrapper = (await rpc.startRpcSession(`image-session-${Date.now()}`, "", cwd, { toolNames: ["read"] })).session;
    assert.ok(wrapper.inner.getAllTools().some((tool) => tool.name === "generate_image"));
    assert.ok(wrapper.inner.getActiveToolNames().includes("generate_image"));

    chatOnlyWrapper = (await rpc.startRpcSession(`image-chat-only-${Date.now()}`, "", cwd, { toolNames: [] })).session;
    assert.ok(!chatOnlyWrapper.inner.getAllTools().some((tool) => tool.name === "generate_image"));
    const direct = await chatOnlyWrapper.send({ type: "generate_image_direct", requestId: "direct-1", arguments: { prompt: "direct generation" } });
    assert.equal(direct.path.startsWith(".pi/generated-images/"), true);
    assert.deepEqual(readFileSync(path.join(cwd, direct.path)), PNG);
    const persisted = readFileSync(chatOnlyWrapper.sessionFile, "utf8");
    assert.match(persisted, /"type":"custom_message".*"customType":"pi-image-result"/);
    assert.equal(persisted.includes(PNG.toString("base64")), false);

    holdNextRequest = true;
    const heldRequestStarted = new Promise((resolve) => { markHeldRequestStarted = resolve; });
    const pendingDirect = chatOnlyWrapper.send({ type: "generate_image_direct", requestId: "direct-2", arguments: { prompt: "cancelled generation" } });
    await heldRequestStarted;
    assert.equal(chatOnlyWrapper.isRunning(), true);
    await assert.rejects(
      chatOnlyWrapper.send({ type: "prompt", message: "must not overlap" }),
      /another session command is running/,
    );
    await chatOnlyWrapper.send({ type: "abort_image_generation", requestId: "direct-2" });
    releaseHeldRequest();
    await assert.rejects(pendingDirect, /cancel/i);

    await chatOnlyWrapper.send({ type: "abort_image_generation", requestId: "direct-3" });
    await assert.rejects(
      chatOnlyWrapper.send({ type: "generate_image_direct", requestId: "direct-3", arguments: { prompt: "cancel before dispatch" } }),
      /cancel/i,
    );
    assert.equal(requestCount, 2);
  } finally {
    await wrapper?.shutdown();
    await chatOnlyWrapper?.shutdown();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(root, { recursive: true, force: true });
  }
});