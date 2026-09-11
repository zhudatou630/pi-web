# 生图

当前支持 xAI Imagine、ChatGPT 订阅（`openai-codex`）、Antigravity Banana 2，以及 sub2api 中转的 GPT Image Flare/Sunburst 和 Grok Imagine。Pi Web 通过一个轻量扩展复用已登录的 Pi provider，不修改 Pi SDK，也不走 OpenAI Platform 官方 Key 或 `pi-antigravity` 插件代码。

界面只展示 `provider` 为 `xai`、`openai-codex`、`antigravity` 或 `sub2api` 的连接。

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
    },
    "chatgpt-flare": {
      "label": "ChatGPT Flare",
      "provider": "openai-codex",
      "model": "gpt-image-2.5-flare",
      "capabilities": {
        "editing": true,
        "sizes": ["auto", "1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"],
        "qualities": ["low", "medium", "high"]
      },
      "defaults": {
        "size": "auto",
        "quality": "medium"
      }
    },
    "banana-2": {
      "label": "Banana 2",
      "provider": "antigravity",
      "model": "gemini-3.1-flash-image",
      "capabilities": {
        "editing": true,
        "sizes": ["auto", "1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"],
        "resolutions": ["1k", "2k"]
      },
      "defaults": {
        "size": "auto",
        "resolution": "1k"
      }
    },
    "gpt-flare": {
      "label": "Relay Flare",
      "provider": "sub2api",
      "model": "gpt-image-2.5-flare",
      "capabilities": {
        "editing": true,
        "sizes": ["auto", "1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"],
        "qualities": ["low", "medium", "high"]
      },
      "defaults": {
        "size": "auto",
        "quality": "medium"
      }
    },
    "grok-relay": {
      "label": "Relay Grok",
      "provider": "sub2api",
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
    },
    "chatgpt-sunburst": {
      "label": "ChatGPT Sunburst",
      "provider": "openai-codex",
      "model": "gpt-image-2.5-sunburst",
      "capabilities": {
        "editing": true,
        "sizes": ["auto", "1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"],
        "qualities": ["low", "medium", "high"]
      },
      "defaults": {
        "size": "auto",
        "quality": "medium"
      }
    }
  }
}
```

- `provider` 必须是 `xai`、`openai-codex`、`antigravity` 或 `sub2api`。认证复用 Pi 已登录的对应 provider，不单独保存图片 API Key。Antigravity 读 `auth.json` 里的 `antigravity` OAuth；sub2api 读 `models.json` 里该 provider 的 API Key。不 import `pi-antigravity`。
- 用户侧选项来自连接声明：比例（`sizes` 里的宽高比，含 `auto`）、分辨率（xAI、Banana 2、sub2api Grok 声明 `1k` / `2k`）、质量。ChatGPT 和 sub2api GPT Image 不声明分辨率。Banana 2 不声明质量。
- 改图一张原图，结果写入新文件，不覆盖原图。未声明 `editing` 的连接不显示改图按钮。
- 参数窗口把比例显示成「自动 / 正方形 1:1 / 横屏 16:9 / 竖屏 9:16」这类标签，不展示像素。ChatGPT 订阅和 sub2api GPT Image 按所选比例发送对应像素：`1:1`→`1024x1024`，`16:9`→`1536x864`，`9:16`→`864x1536`，`3:2`→`1536x1024`，`2:3`→`1024x1536`，`4:3`→`1024x768`，`3:4`→`768x1024`，`auto`→`auto`。xAI 与 sub2api Grok 发送 `aspect_ratio`（含 `auto`）和 `resolution`。Banana 2 发送官方 `aspectRatio` 字符串；`auto` 不带该字段。分辨率映射为 `1K` / `2K`。
- 结果卡片显示实测宽高，不显示请求比例。改图仍可换比例，并按上面映射发出。
- xAI 与 sub2api Grok 走 `{baseUrl}/images/{generations|edits}`，发 `aspect_ratio` / `resolution` / `quality` / `n: 1` / `response_format: "b64_json"`；改图用 `image: { url, type: "image_url" }`。ChatGPT 订阅走 `chatgpt.com/backend-api/codex/images/{generations|edits}`。sub2api GPT Image 走同一中转的 `/images/{generations|edits}`，但发像素 `size`，改图用 `images[].image_url`，不发 `n` / `background` / `response_format`。Banana 2 走 Cloud Code Assist `streamGenerateContent` SSE，改图把一张原图放进 contents，返回 JPEG。上游可能改写尺寸和质量，卡片写实测像素。

创建或修改配置后，对当前会话执行 `/reload`。`generate_image` 工具会出现在除“仅聊天”以外的现有工具预设中；输入栏的图片生成按钮可在所有工具预设中直接使用。

## 使用

- 直接在对话中提出需求。会话里还没有图时，Agent 调用 `generate_image` 文生图；已有图时默认改上一张。Agent 负责把用户的话编译成改动说明，不另开一张。只有用户要另开一张无关的图时才设置 `new_image`。
- 点击输入栏的图片生成按钮，明确填写提示词和该连接声明的选项。这个入口不调用语言模型。
- 在结果卡片上点「改图」，打开同一弹窗，原图已绑死。点引用会把该图作为缩略图芯片放进输入栏；发出去后运行时把它当作 edit 的 source。本条消息里拖入的照片同样自动当原图。

结果保存到当前工作目录的 `.pi/generated-images/`，并在对话中显示预览、路径和实际模型参数。Session 只记录相对路径和元数据，不保存生成图片的 Base64。xAI、sub2api Grok 和 Banana 2 返回 JPEG；ChatGPT 订阅和 sub2api GPT Image 返回 PNG。
