# Pi Web

这是基于 [pi](https://github.com/earendil-works/pi) 和原版 [agegr/pi-web](https://github.com/agegr/pi-web) 修改的分支，主要做了些日常使用上的调整（多标签分屏、中文与代码排版、工具执行流折叠及部分交互修复）。

## 安装与运行

环境要求：Node.js >= 22.19.0。自动读取本机已有的 `~/.pi/agent` 配置。

```bash
git clone https://github.com/zhudatou630/pi-web.git
cd pi-web
npm install
npm run build
npm start
```

启动后访问 `http://127.0.0.1:30141`。

## 代码更新

后续拉取更新，在根目录下执行：

```bash
git pull && npm install && npm run build && npm start
```

## 常用参数

- **改端口**：`npm start -- -p 8080`
- **局域网访问**：`npm start -- -H 0.0.0.0`
- **访问密码**（局域网建议设置，用户名固定为 `pi`）：`PI_WEB_PASSWORD='your-password' npm start`
- **后台常驻 / 不弹浏览器**：`npm start -- --no-open`
- **使用代理**：`HTTP_PROXY=http://127.0.0.1:7890 HTTPS_PROXY=http://127.0.0.1:7890 npm start`

## License

本项目基于 [pi](https://github.com/earendil-works/pi) 与 [agegr/pi-web](https://github.com/agegr/pi-web) 开源生态，遵循 [MIT License](./LICENSE)。
