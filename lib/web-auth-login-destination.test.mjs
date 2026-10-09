import assert from "node:assert/strict";
import test from "node:test";
import { safeLoginDestination } from "./web-auth-login-destination.ts";

const origin = "https://localhost:32123";
test("login returns to same-origin paths, queries and hashes", () => {
  assert.equal(safeLoginDestination("/?session=abc", origin), `${origin}/?session=abc`);
  assert.equal(safeLoginDestination("/?cwd=%2Fhome%2Fpi#top", origin), `${origin}/?cwd=%2Fhome%2Fpi#top`);
});
test("login rejects URL-parser cross-origin tricks and malformed destinations", () => {
  for (const next of [null, "", "session", "https://evil.example/", "javascript:alert(1)", "//evil.example", "/\\evil.example", "/\\/evil.example", "/\t/evil.example", "/\n/evil.example", "/\r/evil.example", "/\\\tevil.example", "//["]) {
    assert.equal(safeLoginDestination(next, origin), "/", JSON.stringify(next));
  }
});
