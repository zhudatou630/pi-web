import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { ToolCallBlock } = await jiti.import("./MessageView.tsx");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");
const render = (input, extra = {}, expanded = true) => renderToStaticMarkup(React.createElement(I18nProvider, null,
  React.createElement(ToolCallBlock, { defaultExpanded: expanded, block: { type: "toolCall", toolCallId: "test", toolName: "custom", input, ...extra } })));

test("flat arguments preserve literal multiline values and every scalar", () => {
  const html = render({ prompt: 'first\n"second"', limit: 0, enabled: false, optional: null, empty: "" });
  assert.match(html, /data-tool-fields/);
  assert.match(html, /first\n&quot;second&quot;/);
  for (const value of ["0", "false", "null"]) assert.match(html, new RegExp(`>${value}</dd>`));
  assert.equal((html.match(/<dt /g) ?? []).length, 5);
});

test("nested arguments keep the entire JSON fallback", () => {
  for (const input of [{ path: "a", edits: [{ old: "x", new: "y" }] }, { query: "x", options: {} }, {}]) {
    const html = render(input);
    assert.doesNotMatch(html, /data-tool-fields/);
    assert.match(html, /<pre/);
  }
});

test("only expanded streaming arguments are partially parsed into literal fields", () => {
  const rawInput = '{"command":"echo first\\necho second", "timeout":';
  const html = render({}, { rawInput });
  assert.match(html, /data-tool-fields/);
  assert.match(html, /echo first\necho second/);
  assert.doesNotMatch(render({}, { rawInput }, false), /data-tool-fields|echo first/);
  for (const raw of ['{', '{"items":[1,', '{"options":{']) {
    assert.doesNotMatch(render({}, { rawInput: raw }), /data-tool-fields/);
  }
});

test("commands with extra scalar params use rows but special views stay special", () => {
  assert.match(render({ command: "echo a\necho b", timeout: 20 }, { toolName: "bash" }), /data-tool-fields/);
  assert.doesNotMatch(render({ command: "echo a" }, { toolName: "bash" }), /data-tool-fields/);
  assert.match(render({ command: "echo a" }, { toolName: "bash" }), /\$ <\/span>echo a/);
  assert.doesNotMatch(render({ path: "a", content: "file body" }, { toolName: "write" }), /data-tool-fields/);
  assert.doesNotMatch(render({ code: "return 1" }, { toolName: "codemode" }), /data-tool-fields/);
});
