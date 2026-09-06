import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { TabBar } = await jiti.import("./TabBar.tsx");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");

function render(tabs, activeTabId = tabs[0]?.id) {
  return renderToStaticMarkup(React.createElement(
    I18nProvider,
    null,
    React.createElement(TabBar, {
      tabs,
      activeTabId,
      onSelectTab() {},
      onCloseTab() {},
    }),
  ));
}

function visibleLabels(html) {
  return [...html.matchAll(/font-weight:[^"]+"[^>]*>([^<]+)</g)].map((match) => match[1]);
}

function tabNodes(html) {
  return html.split('role="tab"').slice(1);
}

test("keeps unique tab labels short and disambiguates only conflicts", () => {
  const tabs = [
    { id: "file:/repo/app/sessions/route.ts", label: "route.ts", filePath: "/repo/app/sessions/route.ts" },
    { id: "file:/repo/app/agent/route.ts", label: "route.ts", filePath: "/repo/app/agent/route.ts" },
    { id: "file:/repo/lib/rpc.ts", label: "rpc.ts", filePath: "/repo/lib/rpc.ts" },
  ];
  const html = render(tabs);
  assert.deepEqual(visibleLabels(html), ["route.ts · sessions", "route.ts · agent", "rpc.ts"]);
  assert.match(html, /title="\/repo\/app\/sessions\/route\.ts"/);
  assert.match(html, /aria-label="route\.ts · sessions"/);
  assert.equal(tabNodes(html).length, tabs.length);
});

test("gives a shallow-unique conflict a shorter parent than deeper twins", () => {
  const html = render([
    { id: "file:/repo/app/api/sessions/route.ts", label: "route.ts", filePath: "/repo/app/api/sessions/route.ts" },
    { id: "file:/repo/app/api/agent/route.ts", label: "route.ts", filePath: "/repo/app/api/agent/route.ts" },
    { id: "file:/repo/lib/api/agent/route.ts", label: "route.ts", filePath: "/repo/lib/api/agent/route.ts" },
  ]);
  assert.deepEqual(visibleLabels(html), [
    "route.ts · sessions",
    "route.ts · app/api/agent",
    "route.ts · lib/api/agent",
  ]);
  assert.doesNotMatch(html, /route\.ts · app\/api\/sessions/);
});

test("keeps a non-basename custom label and file icon source", () => {
  const html = render([
    { id: "file:/repo/docs/README.md", label: "notes", filePath: "/repo/docs/README.md" },
    { id: "file:/repo/app/page.tsx", label: "page.tsx", filePath: "/repo/app/page.tsx" },
  ]);
  assert.deepEqual(visibleLabels(html), ["notes", "page.tsx"]);
  assert.match(html, /aria-label="notes"/);
  assert.doesNotMatch(html, /aria-label="README\.md"/);
  assert.match(html, /title="\/repo\/docs\/README\.md"/);
  assert.match(html, /_file\.svg/);
  assert.match(html, /typescript-react\.svg/);
});

test("windows and root paths keep browser slash rules in the rendered tabs", () => {
  const html = render([
    { id: "file:/route.ts", label: "route.ts", filePath: "/route.ts" },
    { id: "file:C:\\repo\\app\\route.ts", label: "route.ts", filePath: "C:\\repo\\app\\route.ts" },
    { id: "file:D:\\repo\\app\\route.ts", label: "route.ts", filePath: "D:\\repo\\app\\route.ts" },
  ]);
  assert.deepEqual(visibleLabels(html), [
    "route.ts",
    "route.ts · C:/repo/app",
    "route.ts · D:/repo/app",
  ]);
  assert.match(html, /title="C:\\repo\\app\\route\.ts"/);
});

test("closing a conflict restores the short name without changing tab ids", () => {
  const remainingTab = { id: "file:/repo/app/sessions/route.ts", label: "route.ts", filePath: "/repo/app/sessions/route.ts" };
  const remaining = render([remainingTab]);
  assert.deepEqual(visibleLabels(remaining), ["route.ts"]);
  assert.doesNotMatch(remaining, /route\.ts ·/);
  assert.match(remaining, /aria-label="route\.ts"/);
  assert.equal(tabNodes(remaining).length, 1);
});

test("keeps tab roles, keyboard tabindexes, and close controls", () => {
  const html = render([
    { id: "file:/repo/app/page.tsx", label: "page.tsx", filePath: "/repo/app/page.tsx" },
    { id: "term:1", label: "pi-web", filePath: "/work/apps/pi-web", kind: "terminal" },
  ], "term:1");
  assert.match(html, /role="tablist"/);
  const tabs = tabNodes(html);
  assert.equal(tabs.length, 2);
  assert.match(tabs[0], /aria-selected="false"/);
  assert.match(tabs[0], /tabindex="-1"/);
  assert.match(tabs[1], /aria-selected="true"/);
  assert.match(tabs[1], /tabindex="0"/);
  assert.match(html, /aria-label="Close page\.tsx"/);
  assert.match(html, /aria-label="Terminate terminal pi-web"/);
  assert.match(html, /aria-label="Terminal: pi-web"/);
  assert.equal([...html.matchAll(/<button/g)].length, 2);
});
