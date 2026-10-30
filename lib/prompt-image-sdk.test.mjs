import assert from "node:assert/strict";
import test from "node:test";
import { crc32, deflateSync } from "node:zlib";
import { createJiti } from "jiti";

const { importSdkFile } = await createJiti(import.meta.url).import("./builtin-extensions.ts");
const { AgentSession } = await importSdkFile("core/agent-session.js");
const { SettingsManager } = await importSdkFile("core/settings-manager.js");

function pngChunk(type, data) {
  const body = Buffer.concat([Buffer.from(type), data]);
  const size = Buffer.alloc(4);
  size.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(body));
  return Buffer.concat([size, body, checksum]);
}

// A valid 4000x1000 RGBA PNG padded with a text chunk to exactly our 10 MiB attachment limit.
function largePng() {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(4000, 0);
  header.writeUInt32BE(1000, 4);
  header[8] = 8;
  header[9] = 6;
  const chunks = [
    Buffer.from("89504e470d0a1a0a", "hex"),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(Buffer.alloc((4000 * 4 + 1) * 1000))),
    pngChunk("IEND", Buffer.alloc(0)),
  ];
  const padding = Buffer.alloc(10 * 1024 * 1024 - chunks.reduce((sum, chunk) => sum + chunk.length, 0) - 12, 0x61);
  padding[1] = 0; // tEXt keyword separator
  chunks.splice(2, 0, pngChunk("tEXt", padding));
  return { type: "image", data: Buffer.concat(chunks).toString("base64"), mimeType: "image/png" };
}

test("pi normalizes ordinary prompts by default, even without model limits, but not when disabled", async () => {
  const image = largePng();
  const settingsManager = SettingsManager.inMemory();
  assert.equal(settingsManager.getImageAutoResize(), true);
  const normalize = (resize) => AgentSession.prototype._normalizePromptImages.call({
    settingsManager,
    _limitsModel: () => resize ? { inputLimits: { images: { resize } } } : undefined,
  }, [image]);

  const defaults = await normalize();
  assert.equal(defaults.images.length, 1);
  assert.ok(defaults.images[0].data.length < 4.5 * 1024 * 1024);
  assert.equal(defaults.images[0].mimeType, "image/png");
  assert.match(defaults.hints.join("\n"), /2000x500/);

  const custom = await normalize({ maxWidth: 100, maxHeight: 100, maxBytes: 1000 });
  assert.ok(custom.images[0].data.length < 1000);
  assert.match(custom.hints.join("\n"), /100x25/);

  settingsManager.setImageAutoResize(false);
  assert.deepEqual((await normalize()).images, [image]);
});

test("pi's steering and follow-up queues bypass prompt image normalization", async () => {
  const image = { type: "image", data: "ORIGINAL", mimeType: "image/png" };
  for (const [method, queue, send] of [
    ["_queueSteer", "_steeringMessages", "steer"],
    ["_queueFollowUp", "_followUpMessages", "followUp"],
  ]) {
    let queued;
    await AgentSession.prototype[method].call({
      [queue]: [],
      _emitQueueUpdate() {},
      _normalizePromptImages() { assert.fail("queue normalization behavior changed; revisit the browser fallback"); },
      agent: { [send](message) { queued = message; } },
    }, "look", [image]);
    assert.equal(queued.content[1], image);
  }
});

test("queued steer/follow-up images get the prompt's model limits applied by the wrapper", async () => {
  const { AgentSessionWrapper } = await createJiti(import.meta.url, { tsconfigPaths: true }).import("./rpc-manager.ts");
  const header = Buffer.alloc(13);
  header.writeUInt32BE(3000, 0); // a long, narrow screenshot: small in bytes, too large in pixels
  header.writeUInt32BE(10, 4);
  header[8] = 8;
  header[9] = 6;
  const png = Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"), pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(Buffer.alloc((3000 * 4 + 1) * 10))), pngChunk("IEND", Buffer.alloc(0)),
  ]);
  const image = { type: "image", data: png.toString("base64"), mimeType: "image/png" };
  const settingsManager = SettingsManager.inMemory();
  const fit = (model) => AgentSessionWrapper.prototype.fitQueuedImages.call({ inner: { settingsManager, model } }, [image]);

  const [fitted] = await fit({ id: "m", provider: "p" });
  const width = Buffer.from(fitted.data, "base64").readUInt32BE(16);
  assert.equal(width, 2000, "pi's default 2000px limit");
  const [custom] = await fit({ id: "m", provider: "p", inputLimits: { images: { resize: { maxWidth: 500, maxHeight: 500 } } } });
  assert.equal(Buffer.from(custom.data, "base64").readUInt32BE(16), 500);
  settingsManager.setImageAutoResize(false);
  assert.deepEqual(await fit({ id: "m", provider: "p" }), [image]);
});
