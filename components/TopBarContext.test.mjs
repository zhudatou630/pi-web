import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { AgentsDockButton } = await jiti.import("./TopBarContext.tsx");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");

const render = (running) => renderToStaticMarkup(
  React.createElement(I18nProvider, null, React.createElement(AgentsDockButton, { count: 6, running, open: false, onToggle() {} })),
);

test("idle: Agents and the total, at rest tier", () => {
  const html = render(0);
  assert.match(html, /<span class="composer-dock-label">Agents<\/span><span class="composer-dock-count">6<\/span>/);
  assert.doesNotMatch(html, /data-running|session-status-dot/);
  assert.match(html, /aria-label="Agents 6"/);
  assert.match(html, /title="Agents · 6 total"/);
});

test("running: \"2/6\", the running count breathing over the dim total, no dot", () => {
  const html = render(2);
  assert.match(html, /data-running="true"/);
  assert.match(html, /<span class="composer-dock-count"><span class="composer-agents-running">2<\/span>\/6<\/span>/);
  assert.doesNotMatch(html, /session-status-dot/);
  assert.match(html, /aria-label="Agents 2\/6"/);
  assert.match(html, /title="Agents · 2 running · 6 total"/);
});
