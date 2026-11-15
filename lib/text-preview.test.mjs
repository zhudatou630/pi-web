import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { TEXT_PREVIEW_MAX_BYTES } = await jiti.import("./file-types.ts");
const { readTextPreviewChunk } = await jiti.import("./text-preview.ts");

test("BOM-marked UTF-16 LE and BE keep byte offsets and whole surrogate pairs", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "pi-web-text-preview-utf16-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const endian of ["le", "be"]) {
    for (const content of ["你好 😀 tail", "a".repeat(TEXT_PREVIEW_MAX_BYTES / 2 - 2) + "😀\uFEFF尾部", ""]) {
      const bytes = Buffer.from("\uFEFF" + content, "utf16le");
      if (endian === "be") bytes.swap16();
      const filePath = path.join(directory, `${endian}.txt`);
      writeFileSync(filePath, bytes);
      let offset = 0;
      let decoded = "";
      do {
        const chunk = readTextPreviewChunk(filePath, bytes.length, offset);
        assert.ok(chunk.nextOffset > offset);
        assert.equal(chunk.nextOffset % 2, 0);
        assert.doesNotMatch(chunk.content, /[\uD800-\uDBFF]$/u);
        decoded += chunk.content;
        offset = chunk.nextOffset;
        if (!chunk.truncated) break;
      } while (offset < bytes.length);
      assert.equal(offset, bytes.length);
      assert.equal(decoded, content);
    }
  }
});

test("an odd trailing UTF-16 byte cannot stall pagination", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "pi-web-text-preview-utf16-odd-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "odd.txt");
  const bytes = Buffer.concat([Buffer.from("\uFEFFtext", "utf16le"), Buffer.from([0x61])]);
  writeFileSync(filePath, bytes);
  const chunk = readTextPreviewChunk(filePath, bytes.length, 0);
  assert.equal(chunk.content, "text\uFFFD");
  assert.equal(chunk.nextOffset, bytes.length);
  assert.equal(chunk.truncated, false);
});

test("reads large text in contiguous UTF-8 chunks", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "pi-web-text-preview-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "large.txt");
  const content = "a".repeat(TEXT_PREVIEW_MAX_BYTES - 1) + "😀tail";
  writeFileSync(filePath, content);
  const size = statSync(filePath).size;

  const first = readTextPreviewChunk(filePath, size, 0);
  const second = readTextPreviewChunk(filePath, size, first.nextOffset);

  assert.equal(first.truncated, true);
  assert.equal(first.nextOffset, TEXT_PREVIEW_MAX_BYTES - 1);
  assert.equal(second.truncated, false);
  assert.equal(first.content + second.content, content);
  assert.equal(second.nextOffset, size);
});

test("invalid UTF-8 cannot stall pagination", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "pi-web-text-preview-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "binary.txt");
  writeFileSync(filePath, Buffer.alloc(TEXT_PREVIEW_MAX_BYTES + 1, 0x80));

  const chunk = readTextPreviewChunk(filePath, TEXT_PREVIEW_MAX_BYTES + 1, 0);

  assert.equal(chunk.nextOffset, TEXT_PREVIEW_MAX_BYTES);
  assert.equal(chunk.truncated, true);
});