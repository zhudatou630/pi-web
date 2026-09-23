import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("scopes Next.js output file tracing to the pi-web package", async () => {
  const config = await createJiti(import.meta.url).import("../next.config.ts", { default: true });

  assert.equal(config.outputFileTracingRoot, projectRoot);
});

test("the proxy body buffer covers the upload route's 100 MB allowance", async () => {
  // Next caps the buffered request body at 10 MB by default whenever a proxy is
  // present, which silently truncated every upload above that size.
  const { default: config } = await createJiti(import.meta.url).import("../next.config.ts");
  assert.equal(config.experimental.proxyClientMaxBodySize, "128mb");

  const previous = process.env.PI_WEB_MAX_BODY_SIZE;
  try {
    process.env.PI_WEB_MAX_BODY_SIZE = "512kb";
    const sized = await createJiti(import.meta.url, { moduleCache: false })
      .import("../next.config.ts", { default: true });
    assert.equal(sized.experimental.proxyClientMaxBodySize, "512kb");

    // A malformed value must not reach Next as an invalid SizeLimit.
    process.env.PI_WEB_MAX_BODY_SIZE = "not-a-size";
    const invalid = await createJiti(import.meta.url, { moduleCache: false })
      .import("../next.config.ts", { default: true });
    assert.equal(invalid.experimental.proxyClientMaxBodySize, "128mb");
  } finally {
    if (previous === undefined) delete process.env.PI_WEB_MAX_BODY_SIZE;
    else process.env.PI_WEB_MAX_BODY_SIZE = previous;
  }
});
