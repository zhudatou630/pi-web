import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";
import ts from "typescript";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { MarkdownBody } = await jiti.import("./MarkdownBody.tsx");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");
const source = "@startuml\nA -> B\n@enduml";
const url = "https://www.plantuml.com/plantuml/svg/SoWkIImgAStDuN9KqBLJSE9oICrBAStD0G00";

function markup(markdown, isStreaming = false) {
  return renderToStaticMarkup(React.createElement(I18nProvider, null,
    React.createElement(MarkdownBody, { isStreaming }, markdown),
  ));
}

test("both PlantUML fence names show ordinary code and require an explicit render click", () => {
  for (const lang of ["PlantUML", "puml"]) {
    const fence = `\`\`\`${lang}\n${source}\n\`\`\``;
    for (const [markdown, streaming] of [[fence, false], [fence, true], [fence.replace(/^/gm, "> "), true]]) {
      const html = markup(markdown, streaming);
      assert.match(html, /<pre[^>]*>.*A -&gt; B/s);
      assert.match(html, /<button[^>]*class="markdown-code-action"[^>]*>Render on plantuml\.com<\/button>/);
      assert.equal(html.includes('disabled=""'), streaming);
      assert.doesNotMatch(html, /<img|https:\/\/www\.plantuml\.com/);
    }
    assert.doesNotMatch(markup(`\`\`\`${lang}\n \n\`\`\``), /Render on plantuml\.com|<img/);
  }
  assert.doesNotMatch(markup("```text\n" + source + "\n```"), /Render on plantuml\.com/);
});

// Drive the actual render callbacks and effect without loading a browser or making requests.
const file = ts.createSourceFile("PlantUmlBlock.tsx", await readFile(new URL("./PlantUmlBlock.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function mount(name, plantUmlSvgUrl) {
  const declaration = file.statements.find((node) => ts.isFunctionDeclaration(node) && node.name.text === name);
  const { outputText } = ts.transpileModule(`${declaration.getText(file).replace(/^export /, "")}\nreturn ${name};`, { compilerOptions: { jsx: ts.JsxEmit.React } });
  let state, cleanup, pendingEffect;
  const bindings = {
    React, plantUmlSvgUrl, useI18n: () => ({ t: (key) => key }),
    CodeBlock: "code-block", CodeBlockFrame: "code-frame", PreviewToggleButton: "preview-toggle",
    PlantUmlPreview: "plantuml-preview", ImagePreview: "image-preview",
    useState(initial) {
      if (state === undefined) state = initial;
      return [state, (next) => { state = next; }];
    },
    useEffect(effect) { pendingEffect ??= effect; },
  };
  const render = new Function(...Object.keys(bindings), outputText)(...Object.values(bindings));
  return {
    render(props = { code: source, lang: "puml" }) {
      const tree = render(props);
      if (pendingEffect && !cleanup) cleanup = pendingEffect();
      return tree;
    },
    unmount() { cleanup?.(); },
  };
}

test("approval is local to this block and is revoked when its exact source changes", () => {
  const block = mount("PlantUmlBlock");
  const initial = block.render();
  assert.equal(initial.type, "code-block");
  initial.props.headerAction.props.onToggle();
  assert.equal(block.render().props.children.props.code, source);
  assert.equal(mount("PlantUmlBlock").render().type, "code-block", "another instance must not inherit consent");
  assert.equal(block.render({ code: source + "\n", lang: "puml" }).type, "code-block");
  assert.equal(block.render().type, "code-block", "restoring the source must not restore revoked consent");
});

test("preview waits for encoding and load, and carries the no-referrer policy into zoom", async () => {
  const preview = mount("PlantUmlPreview", async (code) => {
    assert.equal(code, source);
    return url;
  });
  assert.match(renderToStaticMarkup(preview.render()), /mermaid-block-loading/);
  await Promise.resolve();
  const [status, wrapper] = preview.render().props.children;
  assert.equal(status.props.role, "status");
  assert.equal(wrapper.props.hidden, true);
  const imagePreview = wrapper.props.children;
  assert.equal(imagePreview.props.referrerPolicy, "no-referrer");
  const image = imagePreview.props.children;
  assert.equal(image.props.src, url);
  assert.equal(image.props.referrerPolicy, "no-referrer");
  image.props.onLoad();
  assert.equal(preview.render().props.children[1].props.hidden, false);
  image.props.onError();
  assert.equal(preview.render().props.children, "chat.plantUmlLoadFailed");
});

test("failed or oversized encodings show an error instead of an image", async () => {
  for (const [encode, key] of [
    [async () => null, "chat.plantUmlTooLong"],
    [async () => { throw new Error(); }, "chat.plantUmlEncodeFailed"],
  ]) {
    const preview = mount("PlantUmlPreview", encode);
    preview.render();
    await Promise.resolve();
    assert.equal(preview.render().props.children, key);
  }
});

test("an encoding that finishes after the preview closes cannot publish an image", async () => {
  let complete;
  const preview = mount("PlantUmlPreview", () => new Promise((resolve) => { complete = resolve; }));
  preview.render();
  preview.unmount();
  complete(url);
  await Promise.resolve();
  assert.match(renderToStaticMarkup(preview.render()), /mermaid-block-loading/);
  assert.doesNotMatch(renderToStaticMarkup(preview.render()), /<img/);
});
