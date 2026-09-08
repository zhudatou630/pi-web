import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { formatTokensK } = await jiti.import("./token-display.ts");

test("formats zero and negative tokens as 0", () => {
  assert.equal(formatTokensK(0), "0");
  assert.equal(formatTokensK(-10), "0");
  assert.equal(formatTokensK(null), "?");
  assert.equal(formatTokensK(undefined), "?");
});

test("formats sub-1k tokens as exact integer", () => {
  assert.equal(formatTokensK(500), "500");
  assert.equal(formatTokensK(100), "100");
  assert.equal(formatTokensK(10), "10");
});

test("formats small k values (1k - 10k) with up to 1 decimal place", () => {
  assert.equal(formatTokensK(1000), "1k");
  assert.equal(formatTokensK(1450), "1.5k");
  assert.equal(formatTokensK(3000), "3k");
  assert.equal(formatTokensK(9940), "9.9k");
});

test("formats mid-range values (10k - 1M) as rounded integer k", () => {
  assert.equal(formatTokensK(61281), "61k");
  assert.equal(formatTokensK(206841), "207k");
  assert.equal(formatTokensK(814373), "814k");
  assert.equal(formatTokensK(841735), "842k");
});

test("formats million values (>= 1M) with M unit and up to 2 decimal places", () => {
  assert.equal(formatTokensK(1000000), "1M");
  assert.equal(formatTokensK(1048576), "1.05M");
  assert.equal(formatTokensK(19089325), "19.09M");
  assert.equal(formatTokensK(19964979), "19.96M");
});
