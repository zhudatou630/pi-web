import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");
const control = source.slice(
  source.indexOf("function NewSessionCwdControl"),
  source.indexOf("function hasSameTranscriptIdentity"),
);

test("path menu and worktree menu are separate", () => {
  assert.match(control, /setBranchMenuOpen\(\(open\) => !open\)/);
  assert.match(control, /onClick=\{\(\) => choose\(wt\.path\)\}/);
  assert.match(control, /aria-label=\{t\("sidebar\.switchWorktree"\)\}/);
  const pathMenu = control.slice(control.indexOf("{menuOpen &&"), control.indexOf("{branchMenuOpen &&"));
  assert.doesNotMatch(pathMenu, /worktrees\.map/);
});

test("path menu renders sidebar workspace state; worktrees refresh on menu open or when the sidebar's info is for another cwd", () => {
  assert.match(control, /projectPaths: string\[\]/);
  assert.match(control, /projectPaths\.map\(\(path\) =>/);
  assert.doesNotMatch(control, /recentPaths|pinnedPaths|cwdRows/);
  assert.match(control, /worktreeInfo:/);
  assert.doesNotMatch(control, /\/api\/sessions/);
  assert.doesNotMatch(control, /\/api\/home/);
  assert.match(control, /if \(!branchMenuOpen && propCoversCwd\) return;/);
  assert.match(control, /\/api\/worktrees\?cwd=/);
});

test("the new-session bar shows a named project's alias, the path stays its tooltip, and AppShell feeds the names", async () => {
  assert.match(control, /projectNameByRoot\?\.get\(displayProject\) \?\? getFileName\(displayProject\)/);
  assert.match(control, /\{projectNameByRoot\?\.get\(path\) \?\? getFileName\(path\)\}/);
  assert.match(control, /onClick=\{\(\) => choose\(path\)\}\s*title=\{path\}/);
  const appShell = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
  assert.match(appShell, /onProjectNamesChange=\{setProjectNameByRoot\}/);
  assert.match(appShell, /projectNameByRoot=\{projectNameByRoot\}/);
});

function find(root, predicate) {
  if (predicate(root)) return root;
  return ts.forEachChild(root, (child) => find(child, predicate));
}
function evaluate(expression, bindings) {
  const js = ts.transpileModule(`return (${expression});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function(...Object.keys(bindings), js)(...Object.values(bindings));
}

test("sidebar exports the same default and renamed project labels, and clearing a name restores the folder name", async () => {
  const sidebar = await readFile(new URL("./SessionSidebar.tsx", import.meta.url), "utf8");
  const paths = await readFile(new URL("../lib/file-paths.ts", import.meta.url), "utf8");
  const compiled = ts.transpileModule(paths, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  const { getFileName } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
  const parsed = ts.createSourceFile("SessionSidebar.tsx", sidebar, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const declaration = find(parsed, (node) => ts.isVariableDeclaration(node) && node.name.getText(parsed) === "projectNameByRoot");
  const workspaceProjects = [{ key: "repo", root: "/home/user/pi-web" }, { key: "win", root: "C:\\work\\research" }];
  const projectNames = new Map();
  const labels = () => evaluate(declaration.initializer.arguments[0].getText(parsed), { workspaceProjects, projectNames, getFileName })();
  assert.deepEqual([...labels()], [["/home/user/pi-web", "pi-web"], ["C:\\work\\research", "research"]]);
  projectNames.set("repo", "Web 项目");
  assert.equal(labels().get("/home/user/pi-web"), "Web 项目");
  projectNames.delete("repo");
  assert.equal(labels().get("/home/user/pi-web"), "pi-web");
});

test("cwd menu receives the exact sidebar order after reorder, including empty projects and resolved worktree roots", async () => {
  const sidebar = await readFile(new URL("./SessionSidebar.tsx", import.meta.url), "utf8");
  const appShell = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
  const parsed = ts.createSourceFile("SessionSidebar.tsx", sidebar, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const effect = find(parsed, (node) => ts.isCallExpression(node) && node.expression.getText(parsed) === "useEffect"
    && node.arguments[0].getText(parsed).includes("onProjectPathsChange"));
  assert.equal(effect.arguments[1].getText(parsed), "[onProjectPathsChange, menuProjects]");
  const menu = find(parsed, (node) => ts.isVariableDeclaration(node) && node.name.getText(parsed) === "menuProjects");
  const writes = [];
  const projects = [{ key: "empty", root: "/empty" }, { key: "repo", root: "/repo" }, { key: "other", root: "/other" }, { key: "archived", root: "/archived" }];
  for (const workspaceProjects of [projects, [projects[2], projects[3], projects[0], projects[1]]]) {
    // Projects living only in the archive are hidden from the sidebar, so the menu drops them too.
    const menuProjects = evaluate(menu.initializer.arguments[0].getText(parsed), {
      workspaceProjects, archivedOnlyProjectKeys: new Set(["archived"]),
    })();
    evaluate(effect.arguments[0].getText(parsed), {
      menuProjects, onProjectPathsChange: (paths) => writes.push(paths),
    })();
  }
  assert.deepEqual(writes, [["/empty", "/repo", "/other"], ["/other", "/empty", "/repo"]]);
  assert.match(appShell, /onProjectPathsChange=\{setProjectPaths\}/);
  assert.match(appShell, /projectPaths=\{projectPaths\}/);
  assert.match(source, /projectPaths=\{projectPaths\}/);
});

test("worktree menu refreshes on every open, retaining the last list on failure and ignoring closed-menu replies", async () => {
  const parsed = ts.createSourceFile("ChatWindow.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const effect = find(parsed, (node) => ts.isCallExpression(node) && node.expression.getText(parsed) === "useEffect"
    && node.arguments[0].getText(parsed).includes("/api/worktrees?cwd="));
  assert.equal(effect.arguments[1].getText(parsed), "[branchMenuOpen, cwd, propCoversCwd]");
  const writes = [];
  const calls = [];
  let response = Response.json({ projectRoot: "/root", currentWorktreePath: "/root/new", worktrees: [{ path: "/root/new", branch: "new" }] });
  const bindings = {
    AbortController, branchMenuOpen: false, cwd: "/root/new", propCoversCwd: true,
    fetch: async (url, options) => { calls.push([url, options]); return response; },
    setRefreshedWorktree: (data) => writes.push(data),
  };
  const open = () => evaluate(effect.arguments[0].getText(parsed), bindings)();
  assert.equal(open(), undefined);
  assert.equal(calls.length, 0);
  bindings.branchMenuOpen = true;
  let cleanup = open();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls[0][0], "/api/worktrees?cwd=%2Froot%2Fnew");
  assert.equal(writes[0].forCwd, "/root/new");
  assert.equal(writes[0].worktrees[0].branch, "new");
  cleanup();
  response = Response.json({ projectRoot: "/root", worktrees: [{ path: "/root/later", branch: "later" }] });
  cleanup = open();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 2);
  assert.equal(writes[1].worktrees[0].branch, "later");
  cleanup();
  response = Response.json({ error: "offline" }, { status: 503 });
  cleanup = open();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(writes.length, 2, "failure keeps the last successful list");
  cleanup();
  const late = Promise.withResolvers();
  bindings.fetch = () => late.promise;
  cleanup = open();
  cleanup(); // Closing or changing cwd aborts the request.
  late.resolve(Response.json({ projectRoot: "/stale", worktrees: [] }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(writes.length, 2);
  // Sidebar info belongs to another project (other pane/tab): look up this cwd with the menu closed.
  bindings.branchMenuOpen = false;
  bindings.propCoversCwd = false;
  bindings.fetch = async (url) => { calls.push([url]); return Response.json({ projectRoot: "/root", worktrees: [{ path: "/root/new", branch: "main" }] }); };
  cleanup = open();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(writes[2].worktrees[0].branch, "main");
  cleanup();
});

test("draft cwd validation uses stable project identity without rekeying/remounting or changing sibling drafts", async () => {
  const text = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
  const parsed = ts.createSourceFile("AppShell.tsx", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const declaration = find(parsed, (node) => ts.isVariableDeclaration(node) && node.name.getText(parsed) === "handleDraftCwdChange");
  const sameProject = { kind: "draft", id: "tab", newSessionDraftKey: "draft-key", newSessionCwd: "/old", projectKey: "/old" };
  const sibling = { ...sameProject, id: "sibling", newSessionDraftKey: "sibling-key" };
  let tabs = [sameProject, sibling];
  const writes = [];
  let validated = { cwd: "/root/worktree", projectKey: "stable-root-key", projectRoot: "/root" };
  const bindings = {
    fetch: async (_url, options) => {
      assert.deepEqual(JSON.parse(options.body), { cwd: "~/project" });
      return Response.json(validated);
    },
    setChatTabs: (update) => { tabs = update(tabs); },
    activeNewSessionDraftKeyRef: { current: "draft-key" },
    setNewSessionCwd: (cwd) => writes.push(["draft", cwd]), setActiveCwd: (cwd) => writes.push(["active", cwd]),
  };
  const change = evaluate(declaration.initializer.arguments[0].getText(parsed), bindings);
  await change("draft-key", "~/project");
  assert.deepEqual(tabs[0], { ...sameProject, newSessionCwd: "/root/worktree", projectKey: "stable-root-key" });
  assert.equal(tabs[1], sibling);
  assert.deepEqual(writes, [["draft", "/root/worktree"], ["active", "/root/worktree"]]);
  validated = { cwd: "/root/linked", projectRoot: "/root" }; // Root fallback for older replies.
  await change("draft-key", "~/project");
  assert.equal(tabs[0].projectKey, "/root");
  const beforeFailure = tabs;
  bindings.fetch = async () => Response.json({ error: "invalid directory" }, { status: 400 });
  const rejectChange = evaluate(declaration.initializer.arguments[0].getText(parsed), bindings);
  await assert.rejects(rejectChange("draft-key", "~/project"), /invalid directory/);
  assert.equal(tabs, beforeFailure);
  assert.doesNotMatch(declaration.getText(parsed), /rekeyDraft|setSessionKey|setNewSessionDraftId/);
});

test("draft chip prefers its own checkout over the sidebar's server-resolved one, and names a detached checkout", () => {
  const parsed = ts.createSourceFile("ChatWindow.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const pick = (name) => find(parsed, (node) => ts.isVariableDeclaration(node) && node.name.getText(parsed) === name).initializer.getText(parsed);
  const worktrees = [{ path: "/repo", branch: "main", isMain: true }, { path: "/repo-wt/feat", branch: "feat", isMain: false }, { path: "/repo-wt/det", branch: null, isMain: false }];
  const current = (cwd, activeWorktree) => evaluate(pick("currentWorktree"), { worktrees, cwd, activeWorktree });
  const sidebarOnMain = { forCwd: "/repo", currentWorktreePath: "/repo" };
  assert.equal(current("/repo-wt/feat", sidebarOnMain).branch, "feat");
  assert.equal(current("/repo/sub", sidebarOnMain).path, "/repo", "foreign server identity is ignored");
  assert.equal(current("/REPO-WT/FEAT", { forCwd: "/REPO-WT/FEAT", currentWorktreePath: "/repo-wt/feat" }).branch, "feat");
  const det = current("/repo-wt/det", sidebarOnMain);
  assert.equal(evaluate(pick("currentBranch"), { currentWorktree: det, getFileName: (p) => p.split("/").pop() }), "det");
});

test("branch menu offers New worktree, created from the project root and then selected", () => {
  const menu = control.slice(control.indexOf("{branchMenuOpen &&"), control.indexOf("{pickerOpen &&"));
  assert.match(menu, /t\("sidebar\.newWorktree"\)/);
  assert.match(control, /body: JSON\.stringify\(\{ cwd: activeWorktree\.projectRoot, branch \}\)/);
  assert.match(control, /await onChange\(data\.path\);/);
});

test("the new-session page: text menus for project and where it runs sit above the composer, under the Pi Web wordmark", () => {
  const attention = source.slice(source.indexOf("attention={("), source.indexOf("const composerStack"));
  assert.match(attention, /\{isEmptyNew && newSessionCwd && onNewSessionCwdChange && \(\s*<NewSessionCwdControl/);
  const heroStart = source.indexOf('className="empty-hero-anchor');
  const hero = source.slice(heroStart, source.indexOf("{composerStack}", heroStart));
  assert.doesNotMatch(hero, /NewSessionCwdControl/);
  assert.match(hero, /<svg[^>]*aria-label="Pi Web"/);
  assert.match(hero, /<AppUpdateNotice \/>/);
  // Project directory · branch for the main checkout, the branch glyph for a linked one.
  assert.match(control, /currentWorktree\?\.isMain \? \(\s*<span className="new-session-pick-label">\{t\("chat\.projectDirectory"\)\} · \{currentBranch\}<\/span>/);
  // "From <branch>" only inside the New worktree form.
  const form = control.slice(control.indexOf("{newBranch === null ? ("), control.indexOf("{newError && ("));
  assert.match(form, /t\("chat\.worktreeBase", \{ branch: mainBranch \}\)/);
  assert.equal((control.match(/chat\.worktreeBase/g) ?? []).length, 1);
  // Open folder… tells the page it was opened, so AppShell lists it as a project.
  assert.match(control, /t\("chat\.openFolder"\)/);
  assert.match(control, /void onChange\(path, true\)\.then\(/);
});

test("Open folder… on the new-session page lists the folder as a project; other cwd changes do not", async () => {
  const text = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
  const parsed = ts.createSourceFile("AppShell.tsx", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const declaration = find(parsed, (node) => ts.isVariableDeclaration(node) && node.name.getText(parsed) === "handleDraftCwdChange");
  let pinned = ["/existing"];
  const bindings = {
    fetch: async () => Response.json({ cwd: "/new/sub", projectKey: "k", projectRoot: "/new" }),
    setChatTabs: () => {}, activeNewSessionDraftKeyRef: { current: "d" }, setNewSessionCwd: () => {}, setActiveCwd: () => {},
    handleUpdatePinnedCwds: (update) => { pinned = update(pinned); },
  };
  const change = evaluate(declaration.initializer.arguments[0].getText(parsed), bindings);
  await change("d", "/new/sub");
  assert.deepEqual(pinned, ["/existing"]);
  await change("d", "/new/sub", true);
  await change("d", "/new/sub", true);
  assert.deepEqual(pinned, ["/existing", "/new"]);
  assert.match(text, /\? \(cwd, opened\) => handleDraftCwdChange\(effectiveDraftKey, cwd, opened\)/);
});

test("the new-session page folds an open file panel and opens it again on leaving", async () => {
  const text = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
  const parsed = ts.createSourceFile("AppShell.tsx", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const effect = find(parsed, (node) => ts.isCallExpression(node) && node.expression.getText(parsed) === "useEffect"
    && node.arguments[1]?.getText(parsed) === "[onNewSessionPage]");
  assert.match(text, /const onNewSessionPage = mainView === "chat" && selectedSession === null && effectiveNewSessionCwd !== null && !isSplitActive;/);
  let open = true;
  const scope = { panelBeforeNewPageRef: { current: null }, setRightPanelOpen: (value) => { open = typeof value === "function" ? value(open) : value; } };
  const run = (onNewSessionPage) => evaluate(effect.arguments[0].getText(parsed), { ...scope, onNewSessionPage })();
  run(true);
  assert.equal(open, false, "entering folds the panel");
  run(true);
  assert.equal(open, false, "staying does not toggle");
  run(false);
  assert.equal(open, true, "leaving restores it");
  run(true);
  open = true; // opened on the page by the user
  run(false);
  assert.equal(open, true, "an explicit open on the page survives leaving");
  open = false;
  run(true);
  run(false);
  assert.equal(open, false, "a closed panel stays closed");
});

test("no worktree choice inside a repo subdirectory; creating or removing one reloads the shared list", async () => {
  assert.match(control, /const subdirectory = activeWorktree\?\.forCwd === cwd && activeWorktree\.isTopLevel === false;/);
  assert.match(control, /\{currentBranch && !subdirectory && \(/);
  assert.match(control, /isTopLevel: data\.isTopLevel/);
  assert.equal((control.match(/onWorktreesChanged\?\.\(\);/g) ?? []).length, 2);
  const sidebar = await readFile(new URL("./SessionSidebar.tsx", import.meta.url), "utf8");
  assert.match(sidebar, /isTopLevel: worktreeState\.isTopLevel,/);
  const appShell = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
  assert.match(appShell, /onWorktreesChanged=\{bumpSidebarRefresh\}/);
});
