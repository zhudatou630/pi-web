# 生图

当前支持 xAI 官方 Imagine 文生图和单张改图。Pi Web 通过一个轻量扩展复用已登录的 `xai` provider（SuperGrok / X 订阅 OAuth 或 `XAI_API_KEY`），不修改 Pi SDK，也不走 sub2API 或 ChatGPT/Codex。

Codex、OpenAI Platform Images、中转网关都还没接。界面只展示 `provider` 为 `xai` 的连接。

## 配置

在 `~/.pi/agent/images.json` 写入图片连接：

```json
{
  "default": "grok-imagine",
  "connections": {
    "grok-imagine": {
      "label": "Grok Imagine",
      "provider": "xai",
      "model": "grok-imagine-image-2.0",
      "capabilities": {
        "editing": true,
        "sizes": ["auto", "1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"],
        "resolutions": ["1k", "2k"],
        "qualities": ["low", "medium"]
      },
      "defaults": {
        "size": "auto",
        "resolution": "1k",
        "quality": "medium"
      }
    }
  }
}
```

- `provider` 必须是 `xai`。认证和 `https://api.x.ai/v1` 复用 Pi 已登录的 xAI，不单独保存图片 API Key。
- 用户侧三个选项：比例（`sizes` 里的宽高比，含 `auto`）、分辨率（`1k` / `2k`）、质量（`low` / `medium`，默认中。官方 `auto` 文生图实际落到 low，不作为产品选项）。
- 改图走 `POST /v1/images/edits`，一张原图，结果写入新文件，不覆盖原图。比例为自动时不传 `aspect_ratio`，由上游跟随原图。
- 参数窗口把比例显示成「自动 / 正方形 1:1 / 横屏 16:9 / 竖屏 9:16」这类标签，不展示像素。
- 请求固定 `response_format: "b64_json"`，这不是用户选项。工具不跟随上游返回的图片 URL。

创建或修改配置后，对当前会话执行 `/reload`。`generate_image` 工具会出现在除“仅聊天”以外的现有工具预设中；输入栏的图片生成按钮可在所有工具预设中直接使用。

## 使用

- 直接在对话中提出需求。会话里还没有图时，Agent 调用 `generate_image` 文生图；已有图时默认改上一张。Agent 负责把用户的话编译成改动说明，不另开一张。只有用户要另开一张无关的图时才设置 `new_image`。
- 点击输入栏的图片生成按钮，明确填写提示词、比例、分辨率和质量。这个入口不调用语言模型。
- 在结果卡片上点「改图」，打开同一弹窗，原图已绑死。点引用会把该图作为缩略图芯片放进输入栏；发出去后运行时把它当作 edit 的 source。本条消息里拖入的照片同样自动当原图。

结果保存到当前工作目录的 `.pi/generated-images/`，并在对话中显示预览、路径和实际模型参数。Session 只记录相对路径和元数据，不保存生成图片的 Base64。xAI 返回的是 JPEG。
