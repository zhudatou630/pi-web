# Pi Web 里的 Worktree

Pi Web 会把同一个 Git 项目的 main checkout 和 linked worktree 放在同一个项目下。你可以用它在不同分支之间切换工作目录，同时保留统一的会话列表。

## 什么时候会看到 Worktree 控件

当左上角选择的是 Git 仓库根目录时，项目选择器下面会出现 worktree 切换控件。

以下情况不会显示：

- 当前目录不是 Git 仓库。
- 当前目录在某个 Git 仓库里面，但不是仓库根目录。
- Git 无法读取这个仓库的 worktree 列表。

如果你在仓库子目录里，先从项目选择器打开仓库根目录，再管理 worktree。

## 切换 Worktree 会影响什么

worktree 切换器决定 Pi Web 接下来使用哪个 checkout。

它会影响：

- 从侧边栏新建的会话。
- 左侧 Explorer 浏览的文件。
- 从 Explorer 插入到输入框里的文件路径。

已有会话仍然按同一个 project root 分组。点开另一个还活着的 worktree 里的会话时，Explorer 会切到那个 checkout；同一 checkout 里的历史会话不会改 Explorer。

## 新建 Worktree

在 worktree 菜单里选择 `New worktree...`，输入 branch name。

Pi Web 会把 checkout 放在：

```text
<repo>-worktrees/<branch>
```

例如 main checkout 是：

```text
/Users/alex/Documents/Workspace/pi-web
```

新建 `codex/worktree-help` 时，目录会是：

```text
/Users/alex/Documents/Workspace/pi-web-worktrees/codex-worktree-help
```

如果这个 branch 已存在，Pi Web 会为它添加 worktree。如果 branch 不存在，Pi Web 会从当前 `HEAD` 创建这个 branch。

## 删除 Worktree

非 main worktree 右侧有删除按钮。它删除的是这个 checkout 目录。

删除 worktree 不会删除：

- Git branch。
- Pi Web 的历史会话。
- main checkout。

如果 worktree 里有未提交或未跟踪文件，Git 会拒绝删除。Pi Web 会再显示 force remove。force remove 会丢弃这个 checkout 里的未提交文件，只在确定不需要这些改动时使用。

## 会话和 Worktree 的关系

Pi Web 按 project root 分组会话，所以 main checkout 和 linked worktree 里的会话会显示在一起。

但每个会话仍然记得自己创建时的 working directory：

- 在某个 worktree 创建的会话，会继续使用那个 worktree path。
- 在 main checkout 创建的会话，会继续使用 main checkout。
- 如果某个 worktree 已被删除，它的历史会话仍会显示在项目下，方便你找回上下文。

## 常见问题

**为什么我看不到 worktree 切换器？**
请确认当前选择的是 Git 仓库根目录。非 Git 目录和仓库子目录会显示一行轻提示，而不是切换器。

**为什么某个 branch 不能创建 worktree？**
Git 不允许同一个 branch 同时被多个 worktree checkout。你可以切到已有的 worktree，或者先删除那个 checkout。

**Git 里还有已经消失的 worktree 记录怎么办？**
Git 有时会保留 prunable worktree 记录。Pi Web 会过滤这些记录，不在切换器里显示。

**Explorer 和当前聊天看起来不在同一个分支？**
Explorer 跟随当前选择的 worktree；聊天跟随打开的会话。如果点开的会话在另一个还活着的 worktree 里，侧边栏会切到那个 checkout。同一 checkout 里点历史会话不会改 Explorer，已删除 worktree 的会话也不会把 Explorer 拽走。

## Implementation notes

- `lib/worktree.ts` resolves linked worktree top-levels back to the main repo `projectRoot`; `listAllSessions()` attaches that to each `SessionInfo` so all worktrees for one repo are grouped together in the sidebar.
- Worktree operations are served by `/api/worktrees` and guarded by the same allowed-root rules as `/api/files`.
- New worktrees are created under `<repoRoot>-worktrees/<sanitized-branch>`. Existing branches are reused; otherwise `git worktree add -b` creates the branch.
- Removing a dirty worktree returns `409` with `{ dirty: true }` so the UI can ask before retrying with `force`.
- Sessions whose cwd points at a removed worktree are inferred back into the main project instead of becoming a phantom project row.
- git prints POSIX-style absolute paths even on Windows, so every path read out of git goes through `toNativePath()` (`lib/paths.ts`) before it is compared or returned. Compare paths with `samePath()`, never `===` — raw equality made `isTopLevel` permanently false on Windows and hid the worktree switcher entirely. Branch names are not paths and must keep their forward slashes. Browser code cannot apply Node path rules, so `/api/worktrees` resolves `currentWorktreePath` server-side; the sidebar must use that identity for highlighting and removal fallback.
