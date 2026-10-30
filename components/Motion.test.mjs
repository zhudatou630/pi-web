import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const walk = (dir) => readdirSync(join(root, dir), { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]);
const files = [...walk("app"), ...walk("components"), ...walk("hooks")]
  .filter((f) => /\.(css|tsx|ts)$/.test(f) && !/\.test\./.test(f));

// Durations a declaration may still spell out: 0 (reduced motion, instant steps).
const isZero = (t) => parseFloat(t) === 0 || t === "0.001ms";

// Literal durations of transition/animation declarations (not delays, not infinite loops).
export function literalDurations(source) {
  const found = [];
  const decl = /\b(transition|animation)(-duration|-delay)?\s*:\s*["'`]?([^;"'`{}\n]+)/g;
  for (const line of source.split("\n")) {
    if (line.includes("motion-exempt")) continue;
    for (const [, , suffix, value] of line.matchAll(decl)) {
      if (suffix === "-delay") continue;
      for (const item of value.split(/,(?![^(]*\))/)) {
        if (/\binfinite\b/.test(item)) continue;
        // A token (or a calc over one) fills the duration slot; later times are delays.
        const times = item
          .replace(/(?:var|calc)\((?:[^()]|\([^()]*\))*(?:motion|transition)(?:[^()]|\([^()]*\))*\)/g, "0s")
          .replace(/\([^)]*\)/g, "")
          .match(/(?<![\w.-])\d*\.?\d+m?s\b/g) ?? [];
        const duration = suffix === "-duration" ? times : times.slice(0, 1);
        found.push(...duration.filter((t) => !isZero(t)));
      }
    }
  }
  return found;
}

test("transition and animation durations use the motion tokens", () => {
  const offenders = files.flatMap((file) =>
    literalDurations(readFileSync(join(root, file), "utf8")).map((t) => `${file}: ${t}`));
  assert.deepEqual(offenders, [], "use var(--motion-fast|base|slow), or mark a one-off with motion-exempt");
});

test("the motion parser tells durations from delays and loops", () => {
  assert.deepEqual(literalDurations("transition: color 0.12s ease, opacity var(--motion-fast) 60ms;"), ["0.12s"]);
  assert.deepEqual(literalDurations("animation: spin 0.8s linear infinite;"), []);
  assert.deepEqual(literalDurations('transition: "width 120ms ease"'), ["120ms"]);
  assert.deepEqual(literalDurations("transition-delay: 0.3s;"), []);
  assert.deepEqual(literalDurations("animation-duration: 0.001ms !important;"), []);
  assert.deepEqual(literalDurations("transition-duration: var(--panel-transition, 0.2s);"), []);
});
