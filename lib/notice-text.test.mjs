import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  return import("./notice-text.ts");
}

// qrcode-terminal's `small` output: █ ▀ ▄ and runs of spaces that must keep their width.
const QR = [
  "▄▄▄▄▄▄▄▄▄▄▄",
  "█ ▄▄▄ █▀▄ █",
  "█ █   █  ▄█",
  "█▄▄▄▄▄█▄▀▄█",
  "▀▀▀▀▀▀▀▀▀▀▀",
].join("\n");

test("keeps a terminal QR code in a notice apart from its prose (#755)", async () => {
  const { splitNoticeText } = await loadSubject();
  const message = `请用微信扫码登录：\n\n${QR}\n\n二维码链接：https://example.com/q`;

  const parts = splitNoticeText(message);

  assert.deepEqual(parts, [
    { kind: "text", text: "请用微信扫码登录：\n\n" },
    { kind: "art", text: QR },
    { kind: "text", text: "\n\n二维码链接：https://example.com/q" },
  ]);
  assert.equal(parts.map((part) => part.text).join(""), message);
});

test("leaves a notice without block characters as one piece of prose", async () => {
  const { splitNoticeText } = await loadSubject();

  assert.deepEqual(splitNoticeText("Saved   to\n  disk"), [{ kind: "text", text: "Saved   to\n  disk" }]);
  assert.deepEqual(splitNoticeText(""), []);
});

test("notice links keep punctuation outside href, parentheses and IPv6 inside", async () => {
  const { splitNoticeLinks } = await loadSubject();
  for (const [text, links] of [
    ["Open http://localhost:39193. Or (https://a.com/x?y=1), done!", ["http://localhost:39193", "https://a.com/x?y=1"]],
    ["打开 http://a.com。然后 https://a.com/docs，谢谢（https://a.com/b）", ["http://a.com", "https://a.com/docs", "https://a.com/b"]],
    ["(https://a.com/Foo_(bar)). http://[::1]:3000/review!", ["https://a.com/Foo_(bar)", "http://[::1]:3000/review"]],
    ["https:// alone and javascript:alert(1)", []],
    ["https://x.com/" + ")".repeat(20_000), ["https://x.com/"]],
  ]) {
    const parts = splitNoticeLinks(text);
    assert.deepEqual(parts.filter((part) => part.kind === "link").map((part) => part.text), links);
    assert.equal(parts.map((part) => part.text).join(""), text);
  }
});

test("starts a new run after a line without blocks", async () => {
  const { splitNoticeText } = await loadSubject();

  assert.deepEqual(splitNoticeText("█▀█\n\n█▄█\nok ▌"), [
    { kind: "art", text: "█▀█" },
    { kind: "text", text: "\n\n" },
    { kind: "art", text: "█▄█\nok ▌" },
  ]);
});
