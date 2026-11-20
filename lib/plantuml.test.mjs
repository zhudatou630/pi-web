import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import { createJiti } from "jiti";

const { plantUmlSvgUrl } = await createJiti(import.meta.url).import("./plantuml.ts");
const endpoint = "https://www.plantuml.com/plantuml/svg/";
const example = "@startuml\nA -> B\n@enduml";

test("PlantUML URLs match the published example and the upstream encoder", async () => {
  // https://plantuml.com/text-encoding
  assert.equal(await plantUmlSvgUrl("Bob -> Alice : hello"), endpoint + "SyfFKj2rKt3CoKnELR1Io4ZDoSa70000");
  assert.equal(await plantUmlSvgUrl(example), endpoint + "SoWkIImgAStDuN9KqBLJSE9oICrBAStD0G00");

  const source = "@startuml\n用户 -> 系统: 登录 ✓\n@enduml";
  const url = await plantUmlSvgUrl(source);
  const base64 = url.slice(endpoint.length).replace(/./g, (char) => (
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"["0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_".indexOf(char)]
  ));
  assert.equal(inflateRawSync(Buffer.from(base64, "base64")).toString("utf8"), source);
  assert.equal(await plantUmlSvgUrl(randomBytes(7000).toString("hex")), null);
});

async function withCompressionStream(value, run) {
  const original = globalThis.CompressionStream;
  globalThis.CompressionStream = value;
  try { await run(); }
  finally { globalThis.CompressionStream = original; }
}

test("hex fallback uses UTF-8 and refuses an oversized full URL", async () => {
  for (const CompressionStream of [undefined, class { constructor() { throw new TypeError("unsupported format"); } }]) {
    await withCompressionStream(CompressionStream, async () => {
      assert.equal(await plantUmlSvgUrl("A -> 乙\n"), endpoint + "~h41202d3e20e4b9990a");
      const fits = "a".repeat(Math.floor((6000 - endpoint.length - 2) / 2));
      assert.ok(await plantUmlSvgUrl(fits));
      assert.equal(await plantUmlSvgUrl(fits + "a"), null);
    });
  }
});

test("unexpected compression failures reject instead of switching to hex", async () => {
  class BrokenCompressionStream extends TransformStream {
    constructor(format) {
      assert.equal(format, "deflate-raw");
      super({ transform() { throw new Error("compression failed"); } });
    }
  }
  await withCompressionStream(BrokenCompressionStream, () => assert.rejects(plantUmlSvgUrl(example), /compression failed/));
});
