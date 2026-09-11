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
const { extractMentionedImagePath, getImageGenerationResult, imageDisplayRatio, imagePixelRatio, imageToolDisplayKind, splitImageMentions, imageRatioKind, xaiAspectRatio } = await jiti.import("./image-generation.ts");
const { buildCodexImageBody, codexImageSize, extractCodexAccountId, resolveCodexImagesUrl } = await jiti.import("./image-generation-codex.ts");
const { antigravityAspectRatio, antigravityImageSize, buildAntigravityImageBody } = await jiti.import("./image-generation-antigravity.ts");
const { buildSub2apiImageBody, resolveSub2apiImagesUrl } = await jiti.import("./image-generation-sub2api.ts");

function fakeCodexToken(accountId = "acct-1") {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } })).toString("base64url");
  return `${header}.${payload}.sig`;
}

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

test("image ratios are classified consistently for the UI and xAI", () => {
  assert.equal(xaiAspectRatio("1024x1024"), "1:1");
  assert.equal(xaiAspectRatio("1024x1536"), "2:3");
  assert.equal(xaiAspectRatio("1:1"), "1:1");
  assert.equal(xaiAspectRatio("auto"), "auto");
  assert.equal(xaiAspectRatio("9:16"), "9:16");
  assert.equal(xaiAspectRatio(), undefined);
  assert.equal(imageRatioKind("auto"), "auto");
  assert.equal(imageRatioKind("9:16"), "portrait");
  assert.equal(imageRatioKind("4:5"), "portrait");
  assert.equal(imageRatioKind("0:0"), null);
  assert.throws(() => xaiAspectRatio("0:0"), /Unsupported image size/);
  assert.equal(imagePixelRatio(1280, 720), "16:9");
  assert.equal(imagePixelRatio(1024, 1536), "2:3");
  assert.equal(imagePixelRatio(1254, 1254), "1:1");
  assert.equal(imageDisplayRatio(2752, 1536), "16:9");
  assert.equal(imageDisplayRatio(1672, 941), "16:9");
  assert.equal(imageDisplayRatio(1024, 1536), "2:3");
});

test("Codex image sizes map to documented pixel strings", () => {
  assert.equal(codexImageSize("auto"), "auto");
  assert.equal(codexImageSize("1:1"), "1024x1024");
  assert.equal(codexImageSize("16:9"), "1536x864");
  assert.equal(codexImageSize("9:16"), "864x1536");
  assert.equal(codexImageSize("4:3"), "1024x768");
  assert.equal(codexImageSize("3:4"), "768x1024");
  assert.equal(codexImageSize("3:2"), "1536x1024");
  assert.equal(codexImageSize("2:3"), "1024x1536");
  assert.equal(codexImageSize(), undefined);
  assert.throws(() => codexImageSize("0:0"), /Unsupported image size/);
  assert.equal(resolveCodexImagesUrl("https://chatgpt.com/backend-api", "generations"), "https://chatgpt.com/backend-api/codex/images/generations");
  assert.equal(resolveCodexImagesUrl("https://chatgpt.com/backend-api/codex", "edits"), "https://chatgpt.com/backend-api/codex/images/edits");
  assert.equal(extractCodexAccountId(fakeCodexToken("acct-9")), "acct-9");
  const generated = buildCodexImageBody("gpt-image-2.5-flare", "a square", undefined, "1:1", "medium");
  assert.deepEqual(generated, {
    prompt: "a square",
    model: "gpt-image-2.5-flare",
    size: "1024x1024",
    quality: "medium",
  });
  assert.equal("n" in generated, false);
  assert.equal("background" in generated, false);
  assert.equal("response_format" in generated, false);
  const edited = buildCodexImageBody("gpt-image-2.5-sunburst", "add a border", { bytes: PNG, mimeType: "image/png" }, "auto", "low");
  assert.deepEqual(edited.images, [{ image_url: `data:image/png;base64,${PNG.toString("base64")}` }]);
  assert.equal(edited.size, "auto");
});

test("image requests reject retired fields and conflicting source modes", async () => {
  const { parseImageGenerationRequest } = await jiti.import("./image-generation-runtime.ts");
  assert.throws(
    () => parseImageGenerationRequest({ prompt: "draw it", references: ["old.png"] }),
    /field references is not supported/,
  );
  assert.throws(
    () => parseImageGenerationRequest({ prompt: "draw it", new_image: true, target: "old.png" }),
    /new_image cannot be combined with an edit source/,
  );
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

test("the host extension stays absent without a runnable image connection", () => {
  const agentDir = mkdtempSync(path.join(tmpdir(), "pi-image-agent-"));
  try {
    writeFileSync(path.join(agentDir, "images.json"), JSON.stringify({
      connections: { proxy: { provider: "openai", model: "image" } },
    }));
    assert.equal(captureTool(agentDir), undefined);
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("Antigravity image sizes map to aspectRatio and imageSize", () => {
  assert.equal(antigravityAspectRatio("auto"), undefined);
  assert.equal(antigravityAspectRatio("16:9"), "16:9");
  assert.equal(antigravityAspectRatio(), undefined);
  assert.throws(() => antigravityAspectRatio("21:9"), /Unsupported image size/);
  assert.equal(antigravityImageSize("1k"), "1K");
  assert.equal(antigravityImageSize("2k"), "2K");
  assert.throws(() => antigravityImageSize("4k"), /Unsupported image resolution/);
  const body = buildAntigravityImageBody("gemini-3.1-flash-image", "proj-1", "a square", "1:1", "2k");
  assert.equal(body.model, "gemini-3.1-flash-image");
  assert.equal(body.project, "proj-1");
  assert.deepEqual(body.request.generationConfig.imageConfig, { aspectRatio: "1:1", imageSize: "2K" });
  const auto = buildAntigravityImageBody("gemini-3.1-flash-image", "proj-1", "a square", "auto", "1k");
  assert.deepEqual(auto.request.generationConfig.imageConfig, { imageSize: "1K" });
  const edited = buildAntigravityImageBody("gemini-3.1-flash-image", "proj-1", "make it red", "16:9", "1k", { bytes: PNG, mimeType: "image/png" });
  assert.deepEqual(edited.request.contents[0].parts, [
    { text: "make it red" },
    { inlineData: { mimeType: "image/png", data: PNG.toString("base64") } },
  ]);
});

test("sub2api image URLs stay on the relay /images path", () => {
  assert.equal(resolveSub2apiImagesUrl("https://relay.example/v1", "generations"), "https://relay.example/v1/images/generations");
  assert.equal(resolveSub2apiImagesUrl("https://relay.example/v1/", "edits"), "https://relay.example/v1/images/edits");
  assert.equal(resolveSub2apiImagesUrl("https://relay.example/v1/images", "edits"), "https://relay.example/v1/images/edits");
  const generated = buildSub2apiImageBody("gpt-image-2.5-flare", "a square", undefined, "1:1", "medium");
  assert.deepEqual(generated, {
    prompt: "a square",
    model: "gpt-image-2.5-flare",
    size: "1024x1024",
    quality: "medium",
  });
  assert.equal("n" in generated, false);
  assert.equal("response_format" in generated, false);
  const edited = buildSub2apiImageBody("gpt-image-2.5-sunburst", "add a border", { bytes: PNG, mimeType: "image/png" }, "auto", "low");
  assert.deepEqual(edited.images, [{ image_url: `data:image/png;base64,${PNG.toString("base64")}` }]);
});

test("the host extension loads an openai-codex connection without xAI", () => {
  const agentDir = mkdtempSync(path.join(tmpdir(), "pi-image-agent-"));
  try {
    writeFileSync(path.join(agentDir, "images.json"), JSON.stringify({
      connections: {
        flare: {
          provider: "openai-codex",
          model: "gpt-image-2.5-flare",
          capabilities: { editing: true, sizes: ["auto"], qualities: ["medium"] },
        },
      },
    }));
    assert.ok(captureTool(agentDir));
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("the host extension loads a sub2api connection without xAI", () => {
  const agentDir = mkdtempSync(path.join(tmpdir(), "pi-image-agent-"));
  try {
    writeFileSync(path.join(agentDir, "images.json"), JSON.stringify({
      connections: {
        flare: {
          provider: "sub2api",
          model: "gpt-image-2.5-flare",
          capabilities: { editing: true, sizes: ["auto"], qualities: ["medium"] },
        },
      },
    }));
    assert.ok(captureTool(agentDir));
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("the host extension loads an antigravity connection without xAI", () => {
  const agentDir = mkdtempSync(path.join(tmpdir(), "pi-image-agent-"));
  try {
    writeFileSync(path.join(agentDir, "images.json"), JSON.stringify({
      connections: {
        banana: {
          provider: "antigravity",
          model: "gemini-3.1-flash-image",
          capabilities: { sizes: ["auto", "1:1"], resolutions: ["1k", "2k"] },
        },
      },
    }));
    assert.ok(captureTool(agentDir));
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
      default: "flare",
      connections: {
        studio: {
          provider: "xai",
          model: "grok-imagine-image-2.0",
          capabilities: { editing: true, sizes: ["auto", "1:1", "9:16", "16:9"], resolutions: ["1k", "2k"], qualities: ["auto", "medium"] },
          defaults: { size: "auto", resolution: "1k", quality: "medium" },
        },
        flare: { provider: "openai", model: "gpt-image-2.5-flare" },
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
      tool.execute("proxy", { prompt: "via openai", connection: "flare" }, undefined, undefined, context),
      /only xai, openai-codex, antigravity, and sub2api are supported/,
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

    context.sessionManager.getBranch = () => [
      { type: "custom_message", details: generated.details },
      {
        type: "message",
        message: {
          role: "user",
          content: [
            { type: "text", text: "@.pi/generated-images/source.png use a different subject" },
            { type: "image", data: PNG.toString("base64"), mimeType: "image/png" },
          ],
        },
      },
    ];
    await tool.execute("fresh", { prompt: "a cat", new_image: true }, undefined, undefined, context);
    assert.equal(calls[5].url, "/v1/images/generations");

    await tool.execute("provider", { prompt: "reuse provider auth", new_image: true }, undefined, undefined, context);
    assert.equal(calls.at(-1).headers["x-image-auth"], "fixture-token");

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

test("the standard tool generates and edits ChatGPT subscription images", { timeout: 15_000 }, async () => {
  const root = mkdtempSync(path.join(tmpdir(), "pi-image-codex-"));
  const agentDir = path.join(root, "agent");
  const cwd = path.join(root, "project");
  mkdirSync(agentDir);
  mkdirSync(cwd);
  const calls = [];
  const server = createServer(async (request, response) => {
    calls.push({ url: request.url, headers: request.headers, body: await requestBody(request) });
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ data: [{ b64_json: PNG.toString("base64") }] }));
  });

  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    writeFileSync(path.join(agentDir, "images.json"), JSON.stringify({
      connections: {
        flare: {
          provider: "openai-codex",
          model: "gpt-image-2.5-flare",
          capabilities: { editing: true, sizes: ["auto", "1:1", "16:9"], qualities: ["low", "medium", "high"] },
          defaults: { size: "auto", quality: "medium" },
        },
      },
    }));
    const tool = captureTool(agentDir);
    const context = {
      cwd,
      sessionManager: { getBranch: () => [] },
      modelRegistry: {
        getProviderAuth: async () => ({ auth: { apiKey: fakeCodexToken() } }),
        getProvider: () => ({ baseUrl: `http://127.0.0.1:${address.port}` }),
      },
    };

    const generated = await tool.execute("generate", { prompt: "a blue square", size: "1:1", quality: "high" }, undefined, undefined, context);
    assert.equal(calls[0].url, "/codex/images/generations");
    assert.equal(calls[0].headers.originator, "pi");
    assert.equal(calls[0].headers["chatgpt-account-id"], "acct-1");
    assert.match(calls[0].headers.authorization, /^Bearer /);
    assert.deepEqual(JSON.parse(calls[0].body.toString()), {
      prompt: "a blue square",
      model: "gpt-image-2.5-flare",
      size: "1024x1024",
      quality: "high",
    });
    const details = getImageGenerationResult(generated.details);
    assert.ok(details);
    assert.equal(details.connection, "flare");
    assert.equal(details.model, "gpt-image-2.5-flare");
    assert.equal(details.size, "1:1");
    assert.equal(details.quality, "high");
    assert.equal(details.resolution, undefined);

    const sourceDir = path.join(cwd, ".pi", "generated-images");
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(path.join(sourceDir, "source.png"), PNG);
    await tool.execute("edit", { prompt: "make it red", target: ".pi/generated-images/source.png" }, undefined, undefined, context);
    assert.equal(calls[1].url, "/codex/images/edits");
    const editedBody = JSON.parse(calls[1].body.toString());
    assert.equal(editedBody.prompt, "make it red");
    assert.equal(editedBody.model, "gpt-image-2.5-flare");
    assert.deepEqual(editedBody.images, [{ image_url: `data:image/png;base64,${PNG.toString("base64")}` }]);
    assert.equal(editedBody.size, "auto");
    assert.equal(editedBody.quality, "medium");
    assert.equal("n" in editedBody, false);
    assert.equal("background" in editedBody, false);
    assert.equal("response_format" in editedBody, false);
    assert.equal("aspect_ratio" in editedBody, false);
    assert.equal("image" in editedBody, false);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
});

test("the standard tool generates and edits sub2api GPT images", { timeout: 15_000 }, async () => {
  const root = mkdtempSync(path.join(tmpdir(), "pi-image-sub2api-"));
  const agentDir = path.join(root, "agent");
  const cwd = path.join(root, "project");
  mkdirSync(agentDir);
  mkdirSync(cwd);
  const calls = [];
  const server = createServer(async (request, response) => {
    calls.push({ url: request.url, headers: request.headers, body: await requestBody(request) });
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ data: [{ b64_json: PNG.toString("base64") }] }));
  });

  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    writeFileSync(path.join(agentDir, "images.json"), JSON.stringify({
      connections: {
        flare: {
          provider: "sub2api",
          model: "gpt-image-2.5-flare",
          capabilities: { editing: true, sizes: ["auto", "1:1", "16:9"], qualities: ["low", "medium", "high"] },
          defaults: { size: "auto", quality: "medium" },
        },
      },
    }));
    const tool = captureTool(agentDir);
    const context = {
      cwd,
      sessionManager: { getBranch: () => [] },
      modelRegistry: {
        getProviderAuth: async () => ({ auth: { apiKey: "sk-fixture" } }),
        getProvider: () => ({ baseUrl: `http://127.0.0.1:${address.port}/v1` }),
      },
    };

    const generated = await tool.execute("generate", { prompt: "a blue square", size: "1:1", quality: "high" }, undefined, undefined, context);
    assert.equal(calls[0].url, "/v1/images/generations");
    assert.match(calls[0].headers.authorization, /^Bearer sk-fixture/);
    assert.equal(calls[0].headers.originator, undefined);
    assert.equal(calls[0].headers["chatgpt-account-id"], undefined);
    assert.deepEqual(JSON.parse(calls[0].body.toString()), {
      prompt: "a blue square",
      model: "gpt-image-2.5-flare",
      size: "1024x1024",
      quality: "high",
    });
    const details = getImageGenerationResult(generated.details);
    assert.ok(details);
    assert.equal(details.connection, "flare");
    assert.equal(details.model, "gpt-image-2.5-flare");
    assert.equal(details.size, "1:1");
    assert.equal(details.quality, "high");
    assert.equal(details.resolution, undefined);

    const sourceDir = path.join(cwd, ".pi", "generated-images");
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(path.join(sourceDir, "source.png"), PNG);
    await tool.execute("edit", { prompt: "make it red", target: ".pi/generated-images/source.png" }, undefined, undefined, context);
    assert.equal(calls[1].url, "/v1/images/edits");
    const editedBody = JSON.parse(calls[1].body.toString());
    assert.equal(editedBody.prompt, "make it red");
    assert.equal(editedBody.model, "gpt-image-2.5-flare");
    assert.deepEqual(editedBody.images, [{ image_url: `data:image/png;base64,${PNG.toString("base64")}` }]);
    assert.equal(editedBody.size, "auto");
    assert.equal(editedBody.quality, "medium");
    assert.equal("n" in editedBody, false);
    assert.equal("response_format" in editedBody, false);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
});

test("the standard tool generates and edits sub2api Grok images", { timeout: 15_000 }, async () => {
  const root = mkdtempSync(path.join(tmpdir(), "pi-image-sub2api-grok-"));
  const agentDir = path.join(root, "agent");
  const cwd = path.join(root, "project");
  mkdirSync(agentDir);
  mkdirSync(cwd);
  const calls = [];
  const server = createServer(async (request, response) => {
    calls.push({ url: request.url, headers: request.headers, body: await requestBody(request) });
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ data: [{ b64_json: PNG.toString("base64") }] }));
  });

  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    writeFileSync(path.join(agentDir, "images.json"), JSON.stringify({
      connections: {
        grok: {
          provider: "sub2api",
          model: "grok-imagine-image-2.0",
          capabilities: { editing: true, sizes: ["auto", "1:1", "16:9"], resolutions: ["1k", "2k"], qualities: ["low", "medium"] },
          defaults: { size: "auto", resolution: "1k", quality: "medium" },
        },
      },
    }));
    const tool = captureTool(agentDir);
    const context = {
      cwd,
      sessionManager: { getBranch: () => [] },
      modelRegistry: {
        getProviderAuth: async () => ({ auth: { apiKey: "sk-fixture" } }),
        getProvider: () => ({ baseUrl: `http://127.0.0.1:${address.port}/v1` }),
      },
    };

    const generated = await tool.execute("generate", { prompt: "a blue square", size: "16:9", resolution: "2k" }, undefined, undefined, context);
    assert.equal(calls[0].url, "/v1/images/generations");
    assert.match(calls[0].headers.authorization, /^Bearer sk-fixture/);
    assert.deepEqual(JSON.parse(calls[0].body.toString()), {
      model: "grok-imagine-image-2.0",
      prompt: "a blue square",
      n: 1,
      response_format: "b64_json",
      aspect_ratio: "16:9",
      resolution: "2k",
      quality: "medium",
    });
    const details = getImageGenerationResult(generated.details);
    assert.ok(details);
    assert.equal(details.connection, "grok");
    assert.equal(details.model, "grok-imagine-image-2.0");
    assert.equal(details.size, "16:9");
    assert.equal(details.resolution, "2k");
    assert.equal("size" in JSON.parse(calls[0].body.toString()), false);

    const sourceDir = path.join(cwd, ".pi", "generated-images");
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(path.join(sourceDir, "source.png"), PNG);
    await tool.execute("edit", { prompt: "make it red", target: ".pi/generated-images/source.png", size: "1:1" }, undefined, undefined, context);
    assert.equal(calls[1].url, "/v1/images/edits");
    const editedBody = JSON.parse(calls[1].body.toString());
    assert.equal(editedBody.prompt, "make it red");
    assert.equal(editedBody.aspect_ratio, "1:1");
    assert.equal(editedBody.image.type, "image_url");
    assert.match(editedBody.image.url, /^data:image\/png;base64,/);
    assert.equal("images" in editedBody, false);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
});

test("the standard tool generates and edits Antigravity Banana 2 images", { timeout: 15_000 }, async () => {
  const root = mkdtempSync(path.join(tmpdir(), "pi-image-antigravity-"));
  const agentDir = path.join(root, "agent");
  const cwd = path.join(root, "project");
  mkdirSync(agentDir);
  mkdirSync(cwd);
  const calls = [];
  const server = createServer(async (request, response) => {
    calls.push({ url: request.url, headers: request.headers, body: await requestBody(request) });
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end(`data: ${JSON.stringify({
      response: {
        candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: PNG.toString("base64") } }] } }],
      },
    })}\n\n`);
  });

  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    writeFileSync(path.join(agentDir, "images.json"), JSON.stringify({
      connections: {
        banana: {
          provider: "antigravity",
          model: "gemini-3.1-flash-image",
          capabilities: { editing: true, sizes: ["auto", "1:1", "16:9"], resolutions: ["1k", "2k"] },
          defaults: { size: "auto", resolution: "1k" },
        },
      },
    }));
    writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({
      antigravity: {
        type: "oauth",
        access: "ya29.fixture-token",
        refresh: "1//fixture",
        expires: Date.now() + 60 * 60 * 1000,
        projectId: "proj-1",
      },
    }));
    const tool = captureTool(agentDir);
    const context = {
      cwd,
      sessionManager: { getBranch: () => [] },
      modelRegistry: {
        getProviderAuth: async () => undefined,
        getProvider: () => ({ baseUrl: `http://127.0.0.1:${address.port}` }),
      },
    };

    const generated = await tool.execute("generate", { prompt: "a blue square", size: "1:1", resolution: "2k" }, undefined, undefined, context);
    assert.equal(calls[0].url, "/v1internal:streamGenerateContent?alt=sse");
    assert.match(calls[0].headers.authorization, /^Bearer ya29\.fixture-token/);
    const sent = JSON.parse(calls[0].body.toString());
    assert.equal(sent.model, "gemini-3.1-flash-image");
    assert.equal(sent.project, "proj-1");
    assert.equal(sent.requestType, "agent");
    assert.deepEqual(sent.request.generationConfig.imageConfig, { aspectRatio: "1:1", imageSize: "2K" });
    assert.equal("n" in sent, false);
    assert.equal("response_format" in sent, false);
    const details = getImageGenerationResult(generated.details);
    assert.ok(details);
    assert.equal(details.connection, "banana");
    assert.equal(details.model, "gemini-3.1-flash-image");
    assert.equal(details.size, "1:1");
    assert.equal(details.resolution, "2k");
    assert.equal(details.quality, undefined);
    assert.deepEqual(readFileSync(path.join(cwd, details.path)), PNG);

    await tool.execute("auto", { prompt: "a square" }, undefined, undefined, context);
    const autoBody = JSON.parse(calls[1].body.toString());
    assert.deepEqual(autoBody.request.generationConfig.imageConfig, { imageSize: "1K" });

    const sourceDir = path.join(cwd, ".pi", "generated-images");
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(path.join(sourceDir, "source.png"), PNG);
    await tool.execute("edit", { prompt: "make it red", target: ".pi/generated-images/source.png" }, undefined, undefined, context);
    assert.equal(calls.length, 3);
    const editedBody = JSON.parse(calls[2].body.toString());
    assert.deepEqual(editedBody.request.contents[0].parts, [
      { text: "make it red" },
      { inlineData: { mimeType: "image/png", data: PNG.toString("base64") } },
    ]);
    assert.deepEqual(editedBody.request.generationConfig.imageConfig, { imageSize: "1K" });
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