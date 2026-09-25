import test from "node:test";
import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { ToolIcon } = await jiti.import("./ToolIcon.tsx");

test("renders specific icons for bash, read, and error states", () => {
  const bashHtml = renderToStaticMarkup(React.createElement(ToolIcon, { toolName: "bash" }));
  assert.ok(bashHtml.includes("<svg"));

  const errorHtml = renderToStaticMarkup(React.createElement(ToolIcon, { toolName: "bash", isError: true }));
  // Error color comes from the step row (icon follows its label); the glyph is the alert circle.
  assert.ok(errorHtml.includes('<circle cx="12" cy="12" r="10"'));

  const readHtml = renderToStaticMarkup(React.createElement(ToolIcon, { toolName: "read" }));
  assert.ok(readHtml.includes("<svg"));
});
