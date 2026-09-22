import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("API key saves do not use ModelRuntime.login's network refresh", async () => {
  const source = await readFile(new URL("../app/api/auth/api-key/[provider]/route.ts", import.meta.url), "utf-8");

  assert.doesNotMatch(source, /modelRuntime\.login\(/);
  assert.match(source, /apiKeyAuth\.login\(/);
  assert.match(source, /signal:\s*req\.signal/);
  assert.match(source, /storeProviderCredential\(provider, credential\)/);
});

test("disconnect does not rewrite enabledModels", async () => {
  const apiKeySource = await readFile(new URL("../app/api/auth/api-key/[provider]/route.ts", import.meta.url), "utf-8");
  const logoutSource = await readFile(new URL("../app/api/auth/logout/[provider]/route.ts", import.meta.url), "utf-8");
  assert.doesNotMatch(apiKeySource, /enabledModels|clearExactEnabledModelsForProvider/);
  assert.doesNotMatch(logoutSource, /enabledModels|clearExactEnabledModelsForProvider/);
  assert.match(apiKeySource, /type_mismatch/);
  assert.match(logoutSource, /type_mismatch/);
});
