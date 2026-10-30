import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
const block = (selector) => css.slice(css.indexOf(selector)).match(/\{([^}]+)\}/)[1];
const fades = css.slice(css.indexOf("@supports (animation-timeline: scroll(self block))"), css.indexOf("/* react-markdown output styles */"));

test("scroll fades use zero-initialized lengths and guarded, 16px scroll timelines", () => {
  for (const edge of ["start", "end"]) {
    const property = block(`@property --scroll-fade-${edge}`);
    assert.match(property, /syntax: "<length>"/);
    assert.match(property, /inherits: false/);
    assert.match(property, /initial-value: 0px/);
    assert.match(css, new RegExp(`@keyframes scroll-fade-${edge} \\{\\s*from \\{ --scroll-fade-${edge}: ${edge === "start" ? "0px" : "16px"}; \\}\\s*to \\{ --scroll-fade-${edge}: ${edge === "start" ? "16px" : "0px"};`));
  }
  assert.match(fades, /and \(animation-range: 0px 16px\)/);
  assert.match(fades, /animation-fill-mode: both/);
  assert.match(fades, /animation-range: 0px 16px, calc\(100% - 16px\) 100%/);
  assert.match(fades, /animation-timeline: scroll\(self block\)/);
  assert.match(fades, /animation-timeline: scroll\(self inline\)/);
  for (const direction of ["bottom", "right"]) {
    assert.ok(fades.includes(`linear-gradient(to ${direction}, transparent, #000 var(--scroll-fade-start), #000 calc(100% - var(--scroll-fade-end)), transparent)`));
  }
  assert.equal(block(".chat-scroll-fade {"), "\n  mask-image: linear-gradient(to bottom, #000 calc(100% - 16px), transparent);\n");
});

test("wrapped code no longer opts into a horizontal scroll mask", () => {
  assert.doesNotMatch(fades, /markdown-code-block/);
});

test("both axes keep an opaque scrollbar strip", () => {
  assert.equal((fades.match(/linear-gradient\(#000, #000\)/g) ?? []).length, 2);
  assert.match(fades, /--scroll-fade-gutter: var\(--sidebar-scrollbar-gutter, 0px\)/);
  assert.match(fades, /mask-size: calc\(100% - var\(--scroll-fade-gutter\)\) 100%, var\(--scroll-fade-gutter\) 100%/);
  assert.match(fades, /mask-size: 100% calc\(100% - var\(--scroll-fade-gutter\)\), 100% var\(--scroll-fade-gutter\)/);
  assert.match(fades, /@supports selector\(::-webkit-scrollbar\)[\s\S]*@media \(pointer: fine\)[\s\S]*--scroll-fade-gutter: 5px/);
});

test("session and file lists opt in without masking the whole sidebar", async () => {
  const sidebar = await readFile(new URL("./SessionSidebar.tsx", import.meta.url), "utf8");
  assert.equal((sidebar.match(/className="sidebar-list-scroll scroll-fade-block"/g) ?? []).length, 2);
  assert.match(sidebar, /ref=\{listScrollRef\}[\s\S]*?className="sidebar-list-scroll scroll-fade-block"/);
  assert.match(sidebar, /className="sidebar-list-scroll scroll-fade-block" style=\{\{ flex: 1 \}\}/);
});

test("table frame owns the border, not the masked scroller", () => {
  assert.match(block(".markdown-table-frame {"), /border: 1px solid var\(--border\)/);
  assert.match(block(".markdown-table-frame {"), /border-radius: var\(--ui-radius-md\)/);
  const wrap = css.match(/^\.markdown-table-wrap \{([^}]+)\}/m)[1];
  assert.match(wrap, /overflow-x: auto/);
  assert.doesNotMatch(wrap, /border|margin/);
});

test("menus and the worktree popover portal to body, while the selection bar stays outside masks", async () => {
  for (const [file, classes] of [
    ["SessionSidebar.tsx", ["project-context-menu menu-surface", "workspace-worktree-switcher menu-surface"]],
    ["FileExplorer.tsx", ["project-context-menu menu-surface file-context-menu"]],
  ]) {
    const source = await readFile(new URL(file, import.meta.url), "utf8");
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const elements = [];
    const visit = (node) => {
      if (ts.isJsxElement(node)) elements.push(node);
      ts.forEachChild(node, visit);
    };
    visit(ast);
    const className = (element) => element.openingElement.attributes.properties
      .find((attr) => ts.isJsxAttribute(attr) && attr.name.getText(ast) === "className")?.initializer?.text;
    for (const name of classes) {
      const menus = elements.filter((element) => className(element) === name);
      assert.ok(menus.length, `${file}: ${name}`);
      // Sidebar-level project menus already sit outside the masked list.
      const portaled = menus.filter((element) => ts.isCallExpression(element.parent)
        && element.parent.expression.getText(ast) === "createPortal");
      assert.equal(portaled.length, 1, `${file}: ${name} needs its body portal`);
      assert.equal(portaled[0].parent.arguments[1].getText(ast), "document.body");
      if (file === "FileExplorer.tsx") {
        assert.match(portaled[0].getText(ast), /role="alertdialog"/);
        assert.match(portaled[0].getText(ast), /autoFocus/);
      }
    }
    const bar = elements.find((element) => className(element) === "sidebar-section-row sidebar-selection-bar");
    if (file === "SessionSidebar.tsx") {
      assert.ok(bar);
      for (let parent = bar.parent; parent; parent = parent.parent) {
        if (ts.isJsxElement(parent)) assert.ok(!className(parent)?.includes("scroll-fade-block"));
      }
      assert.match(source, /closest\("\.project-context-menu"\)/);
      assert.match(source, /!wtMenuRef\.current\?\.contains\(e\.target as Node\)/);
      assert.match(source, /setWtMenuPosition\(\{ left: row\.left \+ 2, top: row\.bottom \+ 4, width: row\.width - 4 \}\)/);
    } else {
      assert.match(source, /closest\("\.file-context-menu"\)/);
      assert.match(source, /event\.key === "Escape"/);
    }
  }
});

test("image export clears masks and animations in the clone and unfolds the table frame", async () => {
  const source = await readFile(new URL("../lib/message-image.ts", import.meta.url), "utf8");
  const exportCss = source.slice(source.indexOf("const EXPORT_CSS"), source.indexOf("const SCROLLERS"));
  assert.match(exportCss, /mask-image:none!important;-webkit-mask-image:none!important;animation:none!important/);
  assert.match(exportCss, /\.markdown-table-frame,\.markdown-table-wrap\{width:max-content!important/);
  assert.doesNotMatch(exportCss, /\.markdown-code-block\{width:max-content/);
  assert.match(source, /fontEmbedCSS: EXPORT_CSS \+ await buildFontEmbedCSS\(el\)/);
  assert.match(source, /const SCROLLERS = "\.markdown-table-wrap, \.markdown-code-block pre"/);
});
