import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url, { tsconfigPaths: true, jsx: { runtime: "automatic" } });
const { ChatInput } = await jiti.import("./ChatInput.tsx");
const { BranchTreeList } = await jiti.import("./BranchNavigator.tsx");
const { I18nProvider } = await jiti.import("../hooks/useI18n.tsx");
const noop = () => {};
function render(component, props) {
  return renderToStaticMarkup(React.createElement(I18nProvider, null, React.createElement(component, props)));
}
test("disabled composer renders a disabled fieldset covering all controls and a locked model picker", () => {
  const props = { disabled: true, onSend: noop, onAbort: noop, isStreaming: false,
    model: { provider: "p", modelId: "m" }, modelList: [{ provider: "p", id: "m", name: "Model" }],
    onModelChange: noop, onThinkingLevelChange: noop, onToolPresetChange: noop, onCompact: noop,
  };
  const html = render(ChatInput, props);
  assert.match(html, /^<fieldset disabled=""/);
  assert.match(html, /<button[^>]*role="combobox"[^>]*disabled=""/);
  assert.ok(html.indexOf('aria-label="Change reasoning level"') < html.lastIndexOf("</fieldset>"));
  assert.ok(html.includes('aria-label="More controls"'));
  const live = render(ChatInput, { ...props, disabled: false });
  assert.doesNotMatch(live, /^<fieldset disabled/);
  assert.doesNotMatch(live, /<button[^>]*role="combobox"[^>]*disabled/);
});
test("ended branch panels keep their rows but disable them when no navigation action is provided", () => {
  const tree = ["a", "b"].map((id) => ({ entry: { type: "message", id, parentId: null, message: { role: "user", content: id, timestamp: 1 } }, children: [] }));
  const html = render(BranchTreeList, { tree, activeLeafId: "a", hasSession: true });
  const buttons = html.match(/<button\b[^>]*>/g);
  assert.equal(buttons.length, 2);
  assert.ok(buttons.every((button) => button.includes('disabled=""')));
  const live = render(BranchTreeList, { tree, activeLeafId: "a", hasSession: true, onLeafChange: noop });
  assert.doesNotMatch(live, /<button[^>]*disabled/);
});
