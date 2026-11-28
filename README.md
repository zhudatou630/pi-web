# Pi Web

[pi](https://github.com/earendil-works/pi) coding agent 的本地浏览器界面，和 pi 共用本机 `~/.pi/agent` 下的配置与会话文件：命令行里开的会话可以在浏览器里接着聊，反过来也一样。

本项目最初 fork 自 [agegr/pi-web](https://github.com/agegr/pi-web)，之后独立开发，界面和功能设计都已和原版分开。感谢 agegr 的原始工作。

<!-- 截图：放到 docs/images/ 后取消注释
![聊天工作区：分屏、过程折叠与中文排版](docs/images/workspace.png)
-->

## 特点

### 聊天工作区

- **多标签与左右分屏**：标签可拖拽、跨窗口移动，显示未读和等待输入标记；草稿在切换标签时保留。规则见 [docs/chat-tabs.md](./docs/chat-tabs.md)。
- **过程与回答分开**：思考和工具调用折叠成一条带耗时的步骤时间线，最终回答单独排版；流式输出显示实时耗时和生成速度。
- **引用与追问**：选中回答或文件内容可作为引用卡片发送，支持多段引用并跳回原处；运行中发送的消息可选择引导（steer）或排队（follow-up）。
- **长会话导航**：整段会话的提问列表、压缩（compaction）历史、未完成回合一键继续。
- **分支**：从任意消息 fork 出新会话（侧栏按父子关系展示），或在同一会话内编辑重来、切换分支。

### 中文与代码排版

- 内置更纱黑体 / 更纱等宽（中文恰好占两个英文字符宽），不依赖本机字体。
- 正文字体方案可选：系统字体（默认）、更纱黑体、霞鹜文楷。
- 一套中性配色（参照 Cursor 与 VS Code 取色），有浅色、深色和跟随系统；字号、字重、圆角都走统一规范，见 [docs/ui.md](./docs/ui.md)。

### 会话与项目

- 多项目侧栏：按项目、按状态或按时间分组，项目拖拽排序、重命名，会话置顶、归档、标记已读未读（含全部标为已读）、批量操作。
- 同一仓库的 Git worktree 归到一个项目下，在新建会话页选择、新建和删除，见 [docs/worktrees.md](./docs/worktrees.md)。

### 文件、终端与浏览器

- 右侧文件面板：多标签预览源码、Markdown（带大纲）、CSV/TSV 表格、图片、PDF、DOCX，文件内查找，Git diff。
- 拖放文件到目录即可上传；输入栏 `@` 引用文件；文件选区可作为引用发进聊天。
- 内置终端（[docs/terminal.md](./docs/terminal.md)），以及在面板里打开本机服务的浏览器标签，远程访问时自动代理（[docs/preview.md](./docs/preview.md)）。

### Agent 能力

- **内置子代理**：`Agent` 工具可派发前台或后台子任务，主代理能查看结果、引导或中止；可按项目开关，见 [docs/subagents.md](./docs/subagents.md)。
- **对话生图**：Agent 调用 `generate_image` 或从输入栏直接生成、改图，支持多种连接，见 [docs/image-generation.md](./docs/image-generation.md)。
- **工具预设**：全部、默认、只读、仅聊天（不加载工具和扩展）。
- 默认加载 pi 的 MCP、codemode、工具搜索扩展，并提供 MCP 配置页面。

### 用量与导出

- Usage 页面：按模型 / 日期统计 token、费用、缓存命中率、首 token 延迟（TTFT）和输出速度（TPS），以及星期 × 小时热力图。
- 会话面板显示上下文构成、费用和子代理用量。
- 回答可导出为图片（宽表格、Mermaid 图会展开），会话可导出为带 YAML frontmatter 的 Markdown。

### 设置与运维

- 网页内管理 provider 登录与 API key、聊天模型列表、模型请求参数、插件与技能（逐项开关、项目级覆盖）、MCP、子代理配置。
- 设置页一键更新并重启；可选密码登录；适配手机触摸操作。
- 界面支持简体中文和英文。

## 安装与运行

环境要求：Node.js >= 22.19.0。自动读取本机已有的 `~/.pi/agent` 配置。

### npm

```bash
npm install -g @calmabacus/pi-web
pi-web
```

### Git

```bash
# 1. 安装依赖并构建
git clone https://github.com/zhudatou630/pi-web.git
cd pi-web
npm install
npm run build

# 2. 启动服务（前台运行）
npm start

# 或后台常驻启动（推荐 AI Agent 自动部署时使用，避免前台卡命令超时）
nohup npm start > pi-web.log 2>&1 &
```

服务启动后，访问 `http://127.0.0.1:30141`。

## 更新

npm 全局安装并通过 `pi-web` 启动时，可从 **设置 → 常规 → 版本与更新** 查看当前版本和更新状态；新会话页面也会提示新版本。点击“更新并重启”后，页面会等待服务恢复并自动刷新。请先结束 Agent / 子代理任务并关闭内置终端；更新期间服务会短暂不可用，配置和会话仍保存在 `~/.pi/agent`。

Git 安装、systemd / PM2 托管，以及没有安装目录写入权限的实例使用手动更新，页面仍会提示新版本。如需单独关闭版本检查，可设置 `PI_WEB_SKIP_VERSION_CHECK=1`。设置了 `PI_OFFLINE`（即使值为空）也不会访问 npm 检查新版本。

npm 手动更新（先停止正在运行的 Pi Web）：

```bash
npm install -g @calmabacus/pi-web@latest
pi-web
```

如果页面更新超时，请查看启动 Pi Web 的终端输出，并使用以上命令恢复。

Git，在项目根目录下执行：

```bash
git pull && npm install && npm run build
npm start # 或后台运行：nohup npm start > pi-web.log 2>&1 &
```

## 常用参数

Git 安装用 `npm start --`，npm 全局安装把前面换成 `pi-web` 即可。

- **改端口**：`npm start -- -p 8080`
- **局域网访问**：`npm start -- -H 0.0.0.0`
- **访问密码**（局域网建议设置，用户名固定为 `pi`）：`PI_WEB_PASSWORD='your-password' npm start`
- **后台常驻 / 不自动弹浏览器**：`npm start -- --no-open`
- **同时开很多页面时走 HTTP/2**：纯 HTTP 下浏览器对同一地址最多 6 条连接、所有标签页共用，而每个打开的聊天、终端和监视中的文件各占一条事件流，开多了其他请求会排队。用终止 TLS 的反向代理即可换成 HTTP/2，Pi Web 无需改动：本机如 `caddy reverse-proxy --from localhost:8443 --to 127.0.0.1:30141`，远程如 `tailscale serve`（外部主机名加入 `PI_WEB_ALLOWED_HOSTS`）。开发者工具 Network 面板的 Protocol 列显示 `h2` 即生效。
- **远程打开本机服务（浏览器标签页）**：设置 `PI_WEB_PREVIEW_PORT` 和 `PI_WEB_PREVIEW_URL`，见 [docs/preview.md](./docs/preview.md)

## 对话生图

创建 `~/.pi/agent/images.json` 后，可以由 Agent 调用内置 `generate_image` 工具，也可以从输入栏直接生成图片。两种入口共用同一个轻量 Pi 扩展，无需修改 Pi SDK。配置与使用方式见 [docs/image-generation.md](./docs/image-generation.md)。

## License

[MIT License](./LICENSE)。本项目最初 fork 自 [agegr/pi-web](https://github.com/agegr/pi-web)，原作者版权声明保留在 LICENSE 中。
