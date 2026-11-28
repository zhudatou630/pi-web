import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { AgentsTopBarButton } = await jiti.import("./TopBarContext.tsx");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");

const render = (props) => renderToStaticMarkup(
  React.createElement(I18nProvider, null, React.createElement(AgentsTopBarButton, { count: 6, running: 0, failed: 0, open: false, onToggle() {}, ...props })),
);

test("idle: the total on a dim, still badge", () => {
  const html = render({});
  assert.match(html, /class="workspace-header-action agents-top-bar-action"/);
  assert.match(html, /<span class="agents-badge" aria-hidden="true">6<\/span>/);
  assert.match(html, /aria-label="Agents · 6 total"/);
});

test("running: only how many still run, solid and breathing, no \"2/6\"", () => {
  const html = render({ running: 2 });
  assert.match(html, /<span class="agents-badge" data-state="running" data-breathing="true" aria-hidden="true">2<\/span>/);
  assert.match(html, /title="Agents · 2 running · 6 total"/);
});

test("an unseen failure turns the badge red, running or not", () => {
  assert.match(render({ failed: 1 }), /data-state="failed" aria-hidden="true">6<\/span>/);
  assert.match(render({ running: 2, failed: 1 }), /data-state="failed" data-breathing="true" aria-hidden="true">2<\/span>/);
  assert.match(render({ failed: 1 }), /title="Agents · 1 failed · 6 total"/);
});

test("side chats only: the glyph without a number", () => {
  const html = render({ count: 0 });
  assert.doesNotMatch(html, /agents-badge/);
  assert.match(html, /aria-label="Agents"/);
});
