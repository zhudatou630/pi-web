import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const { InvalidProviderEntryError, validateProviderEntries } = await createJiti(import.meta.url).import("./model-config-validation.ts");

test("provider validation agrees with the SDK's catalog-independent composition rules", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-provider-validation-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const cases = [
    [{ api: "openai-completions" }, "empty"],
    [{}, "empty"],
    [{ name: "Display only", models: [], modelOverrides: {} }, "empty"],
    [{ oauth: "radius" }, "oauthBaseUrl"],
    [{ modelOverrides: { m: { contextWindow: 1000 } } }, null],
    [{ headers: {} }, null],
    [{ compat: {} }, null],
    [{ apiKey: "TEST_ONLY_KEY" }, null],
    [{ authHeader: false }, null],
    [{ oauth: "radius", baseUrl: "https://example.test" }, null],
    [{ baseUrl: "https://example.test", api: "openai-completions", models: [{ id: "m" }] }, null],
  ];
  for (const [entry, reason] of cases) {
    const providers = { valid: { headers: {} }, relay: entry };
    if (reason) {
      assert.throws(() => validateProviderEntries(providers), (error) => (
        error instanceof InvalidProviderEntryError && error.provider === "relay" && error.reason === reason
      ));
    } else validateProviderEntries(providers);
    const modelsPath = join(dir, "models.json");
    await writeFile(modelsPath, JSON.stringify({ providers }));
    const runtime = await ModelRuntime.create({
      authPath: join(dir, "auth.json"), modelsPath, modelsStorePath: join(dir, "models-store.json"), refreshOnCreate: false,
    });
    if (reason) assert.match(runtime.getError() ?? "", /Provider.*relay/);
    else assert.equal(runtime.getError(), undefined);
  }
  assert.throws(() => validateProviderEntries({ relay: { models: [{ id: " " }] } }), /Provider relay/);
});
