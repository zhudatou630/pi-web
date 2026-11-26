import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  return import("./ansi.ts");
}

test("OSC hyperlinks leave only visible text with BEL or non-greedy ST terminators", async () => {
  const { stripAnsi, normalizeCustomPanelLines } = await loadSubject();
  for (const end of ["\x07", "\x1b\\"]) {
    const link = `\x1b]8;;https://example.com${end}label\x1b]8;;${end}`;
    assert.equal(stripAnsi(`before ${link} middle ${link} after`), "before label middle label after");
    assert.deepEqual(normalizeCustomPanelLines([`│ ${link} │`]), [link]);
    assert.equal(stripAnsi(`\x1b]0;title${end}body\x1b[31mred\x1b[0m`), "bodyred");
  }
});

test("strips ANSI escape sequences", async () => {
  const { stripAnsi } = await loadSubject();

  assert.equal(stripAnsi("\x1b[31mred\x1b[0m plain"), "red plain");
  assert.equal(stripAnsi("\x1b[?25l\x1b[2Kowner/repo@skill  12 installs\x1b[?25h"), "owner/repo@skill  12 installs");
  assert.equal(stripAnsi("answer\x1b_pi:c\x07"), "answer");
});

test("normalizes boxed custom panel lines while preserving ANSI codes", async () => {
  const { normalizeCustomPanelLines, stripAnsi } = await loadSubject();
  const lines = [
    "┌──────┐",
    "│ \x1b[32mOK\x1b[0m   │",
    "└──────┘",
  ];

  const normalized = normalizeCustomPanelLines(lines);

  assert.equal(normalized.length, 1);
  assert.equal(stripAnsi(normalized[0]), "OK");
  assert.match(normalized[0], /\x1b\[32m/);
});

test("pi fake cursors disappear in plain text, boxed panels and the empty fallback", async () => {
  const { stripAnsi, normalizeCustomPanelLines } = await loadSubject();
  const text = "> \x1b_pi:c\x07\x1b_pi:fc\x07中\x1b_pi:/fc\x07";
  assert.equal(stripAnsi(text), "> 中");
  assert.deepEqual(normalizeCustomPanelLines(["┌──────┐", `│ ${text} │`, "└──────┘"]), ["> 中"]);
  assert.deepEqual(normalizeCustomPanelLines(["\x1b_pi:fc\x07 \x1b_pi:/fc\x07"]), [" "]);
  for (const newline of ["\n", "\r\n", "\r"]) {
    assert.ok(stripAnsi(`cut\x1b_pi:fc${newline}body\x07 end`).includes("body"));
  }
  assert.equal(stripAnsi("a\x1b_pi:fc\x1b\\b"), "ab");
});

test("removes pi-tui cursor markers from custom panel output", async () => {
  const { normalizeCustomPanelLines } = await loadSubject();

  assert.deepEqual(normalizeCustomPanelLines(["> value\x1b_pi:c\x07"]), ["> value"]);
});
