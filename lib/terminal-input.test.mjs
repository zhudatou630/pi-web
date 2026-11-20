import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  return import("./terminal-input.ts");
}

function key(keyValue, modifiers = {}) {
  return {
    key: keyValue,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    ...modifiers,
  };
}

test("forwards legacy Ctrl+Space, slash and minus controls", async () => {
  const { toTerminalKeyData } = await loadSubject();
  for (const [value, expected] of [[" ", "\x00"], ["/", "\x1f"], ["-", "\x1f"]]) {
    assert.equal(toTerminalKeyData(key(value, { ctrlKey: true })), expected);
  }
});

test("navigation keys retain every xterm modifier combination", async () => {
  const { toTerminalKeyData } = await loadSubject();
  const navigation = { ArrowUp: "A", ArrowDown: "B", ArrowRight: "C", ArrowLeft: "D", Home: "H", End: "F",
    Insert: "2~", Delete: "3~", PageUp: "5~", PageDown: "6~" };
  for (let bits = 1; bits <= 7; bits++) {
    const modifiers = { shiftKey: Boolean(bits & 1), altKey: Boolean(bits & 2), ctrlKey: Boolean(bits & 4) };
    for (const [name, code] of Object.entries(navigation)) {
      const expected = code.endsWith("~") ? `\x1b[${code.slice(0, -1)};${bits + 1}~` : `\x1b[1;${bits + 1}${code}`;
      assert.equal(toTerminalKeyData(key(name, modifiers)), expected, `${name}: ${bits}`);
    }
  }
});

test("maps navigation and editing keys to terminal sequences", async () => {
  const { toTerminalKeyData } = await loadSubject();

  assert.equal(toTerminalKeyData(key("ArrowDown")), "\x1b[B");
  assert.equal(toTerminalKeyData(key("Home")), "\x1b[H");
  assert.equal(toTerminalKeyData(key("Delete")), "\x1b[3~");
  assert.equal(toTerminalKeyData(key("Tab", { shiftKey: true })), "\x1b[Z");
  assert.equal(toTerminalKeyData(key("Enter", { shiftKey: true })), "\n");
});

test("maps legacy control and alt keys used by pi-tui", async () => {
  const { toTerminalKeyData } = await loadSubject();

  assert.equal(toTerminalKeyData(key("c", { ctrlKey: true })), "\x03");
  assert.equal(toTerminalKeyData(key("]", { ctrlKey: true })), "\x1d");
  assert.equal(toTerminalKeyData(key("ArrowLeft", { altKey: true })), "\x1b[1;3D");
  assert.equal(toTerminalKeyData(key("x", { altKey: true })), "\x1bx");
  assert.equal(toTerminalKeyData(key("v", { ctrlKey: true })), null);
  assert.equal(toTerminalKeyData(key("x", { metaKey: true })), null);
});

test("leaves printable text to the text input and wraps pasted text", async () => {
  const { asBracketedPaste, toTerminalKeyData } = await loadSubject();

  assert.equal(toTerminalKeyData(key("a")), null);
  assert.equal(toTerminalKeyData(key(" ")), null);
  assert.equal(asBracketedPaste("first\nsecond"), "\x1b[200~first\nsecond\x1b[201~");
  // Markers inside the text would end the paste early, including one that removal rejoins.
  assert.equal(asBracketedPaste("a\x1b[201~b\x1b[200~c\x1b[20\x1b[201~1~d"), "\x1b[200~abcd\x1b[201~");
  assert.equal(asBracketedPaste(""), "\x1b[200~\x1b[201~");
  const nested = `${"\x1b[20".repeat(50_000)}${"1~".repeat(50_000)}`;
  assert.equal(asBracketedPaste(`a${nested}b`), "\x1b[200~ab\x1b[201~");
});
