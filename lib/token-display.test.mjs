import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { formatTokensK } = await jiti.import("./token-display.ts");

test("formats zero and negative tokens as 0k", () => {
  assert.equal(formatTokensK(0), "0k");
  assert.equal(formatTokensK(-10), "0k");
  assert.equal(formatTokensK(null), "?");
  assert.equal(formatTokensK(undefined), "?");
});

test("formats sub-1k tokens with decimal k", () => {
  assert.equal(formatTokensK(500), "0.5k");
  assert.equal(formatTokensK(100), "0.1k");
  assert.equal(formatTokensK(10), "<0.1k");
});

test("formats small k values (1k - 10k) with up to 1 decimal place", () => {
  assert.equal(formatTokensK(1000), "1k");
  assert.equal(formatTokensK(1450), "1.5k");
  assert.equal(formatTokensK(3000), "3k");
  assert.equal(formatTokensK(9940), "9.9k");
});

test("formats large k values (>= 10k) as rounded integer k", () => {
  assert.equal(formatTokensK(61281), "61k");
  assert.equal(formatTokensK(206841), "207k");
  assert.equal(formatTokensK(814373), "814k");
  assert.equal(formatTokensK(841735), "842k");
  assert.equal(formatTokensK(1048576, "en"), "1,049k");
  assert.equal(formatTokensK(19089325, "en"), "19,089k");
  assert.equal(formatTokensK(19964979, "en"), "19,965k");
});
