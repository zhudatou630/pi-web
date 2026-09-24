# Pi Web

这是 [pi](https://github.com/earendil-works/pi) 的本地浏览器界面，基于原版 [agegr/pi-web](https://github.com/agegr/pi-web)。共用本机 `~/.pi/agent` 配置和会话文件。这个分支主要改日常使用：多标签分屏、中文与代码排版、工具过程折叠、对话生图、内置子代理，以及移动端和若干交互修复。

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

Git 安装、systemd / PM2 托管，以及没有安装目录写入权限的实例使用手动更新。可设置 `PI_WEB_SKIP_VERSION_CHECK=1` 关闭版本检查。

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

## 对话生图

创建 `~/.pi/agent/images.json` 后，可以由 Agent 调用内置 `generate_image` 工具，也可以从输入栏直接生成图片。两种入口共用同一个轻量 Pi 扩展，无需修改 Pi SDK。配置与使用方式见 [docs/image-generation.md](./docs/image-generation.md)。

## License

本项目基于 [pi](https://github.com/earendil-works/pi) 与 [agegr/pi-web](https://github.com/agegr/pi-web) 开源生态，遵循 [MIT License](./LICENSE)。
