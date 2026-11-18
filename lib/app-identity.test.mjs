import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const { appIconVersion, parseAppIdentity, readAppIdentity, writeAppIdentity } = await createJiti(import.meta.url).import("./app-identity.ts");

test("parseAppIdentity trims the name and accepts only preset colors", () => {
  assert.deepEqual(parseAppIdentity({ name: "  Home  ", color: "blue" }), { name: "Home", color: "blue" });
  assert.deepEqual(parseAppIdentity({ name: "", color: "default" }), { name: "", color: "default" });
  for (const bad of [
    null,
    [],
    { name: "x" },
    { name: 1, color: "blue" },
    { name: "x", color: "chartreuse" },
    { name: "x", color: "toString" },
    { name: "x".repeat(41), color: "blue" },
  ]) assert.equal(typeof parseAppIdentity(bad), "string", JSON.stringify(bad));
});

test("readAppIdentity falls back to the default for missing or broken files", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-web-identity-"));
  try {
    const path = join(dir, "pi-web", "app-identity.json");
    const stock = { name: "", color: "default" };
    assert.deepEqual(readAppIdentity(path), stock);
    writeAppIdentity({ name: "Work", color: "green" }, path);
    assert.deepEqual(readAppIdentity(path), { name: "Work", color: "green" });
    writeFileSync(path, "{ not json");
    assert.deepEqual(readAppIdentity(path), stock);
    writeFileSync(path, JSON.stringify({ name: "Work", color: "nope" }));
    assert.deepEqual(readAppIdentity(path), stock);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("appIconVersion is null for the stock icon and changes with the color only", () => {
  assert.equal(appIconVersion({ name: "Any", color: "default" }), null);
  const blue = appIconVersion({ name: "A", color: "blue" });
  assert.match(blue, /^[0-9a-f]{10}$/);
  assert.equal(appIconVersion({ name: "B", color: "blue" }), blue);
  assert.notEqual(appIconVersion({ name: "A", color: "green" }), blue);
});
