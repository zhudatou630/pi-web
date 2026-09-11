# Pi Web

这是基于 [pi](https://github.com/earendil-works/pi) 和原版 [agegr/pi-web](https://github.com/agegr/pi-web) 修改的分支，主要做了些日常使用上的调整（多标签分屏、中文与代码排版、工具执行流折叠及部分交互修复）。

## 安装与运行

环境要求：Node.js >= 22.19.0。自动读取本机已有的 `~/.pi/agent` 配置。

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

## 代码更新

后续拉取更新，在项目根目录下执行：

```bash
git pull && npm install && npm run build
npm start # 或后台运行：nohup npm start > pi-web.log 2>&1 &
```

## 常用参数

- **改端口**：`npm start -- -p 8080`
- **局域网访问**：`npm start -- -H 0.0.0.0`
- **访问密码**（局域网建议设置，用户名固定为 `pi`）：`PI_WEB_PASSWORD='your-password' npm start`
- **后台常驻 / 不自动弹浏览器**：`npm start -- --no-open`

## 对话生图

创建 `~/.pi/agent/images.json` 后，可以由 Agent 调用内置 `generate_image` 工具，也可以从输入栏直接生成图片。两种入口共用同一个轻量 Pi 扩展，无需修改 Pi SDK。配置与使用方式见 [docs/image-generation.md](./docs/image-generation.md)。

## License

本项目基于 [pi](https://github.com/earendil-works/pi) 与 [agegr/pi-web](https://github.com/agegr/pi-web) 开源生态，遵循 [MIT License](./LICENSE)。
