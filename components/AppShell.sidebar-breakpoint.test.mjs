import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Script } from "node:vm";
import ts from "typescript";

const sourceText = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
const source = ts.createSourceFile("AppShell.tsx", sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function find(predicate, node = source) {
  if (predicate(node)) return node;
  return ts.forEachChild(node, (child) => find(predicate, child));
}
const breakpoint = find((node) => ts.isCallExpression(node) && node.expression.getText(source) === "useEffect"
  && node.arguments[0]?.getText(source).includes("setSidebarOpen(isMobile ? false : desktopSidebarOpenRef.current)"));
const toggle = find((node) => ts.isVariableDeclaration(node) && node.name.getText(source) === "handleSidebarToggle");
const compile = (callback) => new Script(ts.transpileModule(`(${callback.getText(source)})`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText);

test("mobile drawer actions preserve both open and collapsed desktop sidebar preferences", () => {
  assert.match(sourceText, /desktopSidebarOpenRef = useRef\(true\)/);
  for (const initialOpen of [true, false]) {
    let sidebarOpen = initialOpen;
    const context = {
      isMobile: false,
      desktopSidebarOpenRef: { current: initialOpen },
      setSidebarOpen(value) { sidebarOpen = typeof value === "function" ? value(sidebarOpen) : value; },
      setActiveTopPanel() {},
    };
    const resize = () => compile(breakpoint.arguments[0]).runInNewContext(context)();
    const toggleSidebar = () => compile(toggle.initializer.arguments[0]).runInNewContext(context)();
    context.isMobile = true;
    resize();
    assert.equal(sidebarOpen, false);
    toggleSidebar();
    assert.equal(sidebarOpen, true);
    context.setSidebarOpen(false); // select a chat / dismiss mobile drawer
    assert.equal(context.desktopSidebarOpenRef.current, initialOpen);
    context.isMobile = false;
    resize();
    assert.equal(sidebarOpen, initialOpen);
    toggleSidebar();
    assert.equal(context.desktopSidebarOpenRef.current, !initialOpen);
    context.isMobile = true;
    resize();
    context.isMobile = false;
    resize();
    assert.equal(sidebarOpen, !initialOpen);
  }
});
