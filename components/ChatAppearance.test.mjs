import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import postcss from "postcss";
import { createJiti } from "jiti";

const chatWindow = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");
const chatInput = await readFile(new URL("./ChatInput.tsx", import.meta.url), "utf8");
const settingsPanel = await readFile(new URL("./SettingsPanel.tsx", import.meta.url), "utf8");
const globals = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
const chatAppearanceHook = await readFile(new URL("../hooks/useChatAppearance.ts", import.meta.url), "utf8");
const jiti = createJiti(import.meta.url);
const { clampChatContentWidth, clampChatContentFontSize } = await jiti.import("../hooks/useChatAppearance.ts");

const widthVariable = /var\(--chat-content-max-width, 820px\)/g;

test("chat content keeps the existing 820px default behind one shared variable", () => {
  assert.equal((chatWindow.match(widthVariable) ?? []).length, 2);
  assert.equal((chatInput.match(widthVariable) ?? []).length, 1);
  assert.match(globals, /--chat-content-max-width: 820px;/);
  assert.doesNotMatch(chatWindow, /max-w-\[820px\]|maxWidth: 820/);
  assert.doesNotMatch(chatInput, /maxWidth: 820/);
});

test("General chat settings own the chat width preference", () => {
  assert.match(chatInput, /useChatAppearance\(\)/);
  assert.match(settingsPanel, /useChatAppearance\(\)/);
  assert.match(settingsPanel, /type="range"/);
  assert.match(settingsPanel, /min=\{CHAT_CONTENT_WIDTH_MIN\}/);
  assert.match(settingsPanel, /max=\{CHAT_CONTENT_WIDTH_MAX\}/);
  assert.match(settingsPanel, /step=\{10\}/);
  assert.match(chatAppearanceHook, /pi-chat-content-width/);
  assert.match(chatAppearanceHook, /localStorage\.setItem/);
});

test("chat width validation preserves the default and supported range", () => {
  assert.equal(clampChatContentWidth(undefined), 820);
  assert.equal(clampChatContentWidth("invalid"), 820);
  assert.equal(clampChatContentWidth(700), 820);
  assert.equal(clampChatContentWidth(1104), 1104);
  assert.equal(clampChatContentWidth(2400), 2000);
});

test("markdown hierarchy uses spacing and neutral emphasis without changing link semantics", () => {
  const css = postcss.parse(globals);
  const declaration = (selector, property) => {
    let value;
    css.walkRules(selector, (rule) => {
      rule.walkDecls(property, (decl) => { value = decl.value; });
    });
    assert.notEqual(value, undefined, `${selector}: ${property}`);
    return value;
  };
  const sizes = [1, 2, 3].map((level) => (
    parseFloat(declaration(`.markdown-body h${level}`, "font-size"))
  ));
  assert.ok(sizes[0] > sizes[1] && sizes[1] > sizes[2] && sizes[2] >= 1);
  assert.equal(declaration(".markdown-body > :is(h1, h2, h3, h4, h5, h6):first-child", "margin-top"), "0");
  assert.equal(declaration(".markdown-body li::marker", "color"), "var(--text-muted)");
  assert.equal(declaration(".markdown-body strong", "color"), "var(--text)");
  assert.equal(declaration(".markdown-body strong", "font-weight"), "700");
  assert.equal(declaration(".markdown-body a", "color"), "var(--accent)");
  assert.equal(declaration(".markdown-body a", "text-decoration"), "underline");
});

test("mobile composer keeps full-sized touch targets without enlarging the icons", () => {
  const css = postcss.parse(globals);
  const mobile = css.nodes.find((node) => node.type === "atrule" && node.name === "media" && node.params === "(max-width: 640px)" && node.toString().includes(".chat-input-action"));
  assert.ok(mobile);
  const action = mobile.nodes.find((node) => node.type === "rule" && node.selector === ".chat-input-action");
  const values = Object.fromEntries(action.nodes.filter((node) => node.type === "decl").map((node) => [node.prop, node.value]));
  assert.equal(values.width, "44px");
  assert.equal(values["min-width"], "44px");
  assert.equal(values.height, undefined, "do not override the component's mobile 44px height");
  assert.doesNotMatch(mobile.toString(), /\.chat-input-action svg/);
});

test("chat font size preserves the default and bounds stored or supplied values", () => {
  for (const value of [undefined, null, "invalid", Infinity, NaN]) {
    assert.equal(clampChatContentFontSize(value), 14);
  }
  assert.equal(clampChatContentFontSize(8), 12);
  assert.equal(clampChatContentFontSize("18"), 18);
  assert.equal(clampChatContentFontSize(18.7), 19);
  assert.equal(clampChatContentFontSize(30), 24);
});
