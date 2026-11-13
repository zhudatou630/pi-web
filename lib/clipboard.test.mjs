import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { copyText, copyPendingText } from "./clipboard.ts";

function browser(t, result = true, clipboard) {
  const previous = Object.fromEntries(["navigator", "document", "ClipboardItem"].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  t.after(() => {
    for (const [key, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  const define = (key, value) => Object.defineProperty(globalThis, key, { value, configurable: true });
  let removed = 0;
  const textarea = { style: {}, select() {}, remove() { removed++; } };
  define("navigator", { clipboard });
  define("document", { createElement: () => textarea, body: { appendChild() {} }, execCommand(command) {
    assert.equal(command, "copy");
    if (result instanceof Error) throw result;
    return result;
  } });
  return { textarea, removed: () => removed, define };
}

for (const result of [true, false, new Error("browser failure")]) {
  test(`fallback copy ${String(result)} always removes its temporary node`, async (t) => {
    const dom = browser(t, result);
    if (result === true) await copyText("text");
    else await assert.rejects(copyText("text"), result === false ? /refused/ : /browser failure/);
    assert.equal(dom.removed(), 1);
    assert.equal(dom.textarea.value, "text");
  });
}

test("async clipboard success and rejection propagate without the fallback", async (t) => {
  const calls = [];
  const dom = browser(t, true, { writeText(text) {
    calls.push(text);
    return text === "denied" ? Promise.reject(new Error("denied")) : Promise.resolve();
  } });
  await copyText("ok");
  await assert.rejects(copyText("denied"), /denied/);
  assert.deepEqual(calls, ["ok", "denied"]);
  assert.equal(dom.removed(), 0);
});

test("Safari starts pending-text writes synchronously inside the gesture", async (t) => {
  let item;
  let started = false;
  const dom = browser(t, true, { write(items) { started = true; item = items[0]; return item.data["text/plain"].then(() => {}); } });
  dom.define("ClipboardItem", class { constructor(data) { this.data = data; } });
  let resolve;
  const pending = new Promise((done) => { resolve = done; });
  const copied = copyPendingText(pending);
  assert.equal(started, true);
  resolve("loaded");
  await copied;
  assert.equal(await (await item.data["text/plain"]).text(), "loaded");
  await assert.rejects(copyPendingText(Promise.reject(new Error("loading failed"))), /loading failed/);
});

test("pending-text fallback propagates a refused copy", async (t) => {
  browser(t, false);
  await assert.rejects(copyPendingText(Promise.resolve("loaded")), /refused/);
});

test("every copy button handles rejection before claiming Copied", async () => {
  let checked = 0;
  for (const name of ["AppShell", "MessageView", "MarkdownBody", "MarkdownCopyButton", "TabBar"]) {
    const source = await readFile(new URL(`../components/${name}.tsx`, import.meta.url), "utf8");
    const file = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const visit = (node) => {
      if (ts.isCallExpression(node) && node.expression.getText(file) === "copyText") {
        let chain = node;
        while (ts.isPropertyAccessExpression(chain.parent) && ts.isCallExpression(chain.parent.parent)) chain = chain.parent.parent;
        const text = chain.getText(file);
        assert.ok(/\.catch\(/.test(text) || /,\s*\(\) => \{\}\)/.test(text), `${name}: ${text}`);
        checked++;
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  assert.equal(checked, 9);
  const hook = await readFile(new URL("../hooks/useAgentSession.ts", import.meta.url), "utf8");
  assert.match(hook, /copied\.catch\(\(\) => \{\}\)/);
  assert.match(hook, /await copied;[\s\S]{0,200}return complete\(\{ handled: true, message: "Copied/);
  const file = ts.createSourceFile("useAgentSession.ts", hook, ts.ScriptTarget.Latest, true);
  function find(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(file) === "handleBuiltinSlashCommand") return node.initializer.arguments[0];
    return ts.forEachChild(node, find);
  }
  const callback = find(file).getText(file);
  for (const refused of [false, true]) {
    const notices = [];
    const bindings = {
      sessionIdRef: { current: "session" },
      sendAgentCommand: async () => ({ text: "last answer" }),
      copyPendingText: async (pending) => { await pending; if (refused) throw new Error("Copy was refused"); },
      addNotice: (notice) => notices.push(notice),
      t: (key) => { assert.equal(key, "chat.copyFailed"); return "复制失败"; },
    };
    const code = ts.transpileModule(`return (${callback});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    const command = new Function(...Object.keys(bindings), code)(...Object.values(bindings));
    const result = await command("/copy");
    assert.equal(result.handled, true);
    assert.equal(notices.length, 1);
    assert.equal(notices[0].type, refused ? "error" : "success");
    if (refused) assert.equal(result.error, "复制失败");
    else assert.equal(result.message, "Copied last assistant message");
  }
});
