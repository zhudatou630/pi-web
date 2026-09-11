# 生图

Pi Web 内置生图：输入栏按钮、结果卡（改图 / 引用 / 下载）、一个 `generate_image` 工具。结果写入当前工作目录的 `.pi/generated-images/`。包插件里的同名工具会让位给这个内置工具。

默认关闭。打开后才注册工具、才出现输入栏按钮。对标内置 subagents：扩展工厂一直在，关掉则不注册工具。`pi-antigravity` 自己的工具不受影响。

## 开关

在 Settings → Images：

1. 「启用生图」总开关。改完后需要 `/reload` 当前会话，Agent 才会拿到或丢掉 `generate_image`。输入栏按钮在关掉设置面板后就会更新。
2. 总开关打开后，列出内置连接和自定义连接，每条可单独开关。没登录的仍显示在设置里，但不会出现在生图弹窗里。
3. 弹窗里的连接 = 总开关开 ∧ 该连接 enabled ∧ 对应 provider 已有凭证。关掉 Grok Imagine 不会自动关掉 Relay Grok，它们是两条连接。

没有 `~/.pi/agent/images/settings.json`、也没有旧的 `~/.pi/agent/images.json`：总开关关，入口不出现。

若还没有 settings 文件、但已经有 `images.json`：总开关视为开，并把旧连接读进来（祖父条款）。在 Settings 里拧过一次之后，以 `images/settings.json` 为准，不再读 `images.json` 里的内置条目。

内置连接的模型与参数由代码认领，不写进用户文件。用户文件只存总开关、各内置 id 的 enabled、以及自定义连接。

认证一律走 Pi 已登录的对应 provider（`getProviderAuth`）。生图代码不读 `auth.json`、不自己刷新 OAuth、不内嵌客户端密钥。

## 内置连接

| 连接 | provider | 模型 |
|---|---|---|
| ChatGPT Flare | `openai-codex` | `gpt-image-2.5-flare` |
| ChatGPT Sunburst | `openai-codex` | `gpt-image-2.5-sunburst` |
| Grok Imagine | `xai` | `grok-imagine-image-2.0` |
| Banana 2 | `antigravity` | `gemini-3.1-flash-image` |

比例产品面统一：`auto / 1:1 / 16:9 / 9:16 / 4:3 / 3:4 / 3:2 / 2:3`。卡片写实测像素；近标准比会贴到 16:9 这类标签，不假装请求比例。上游改写 size/quality 时，产品接受。

ChatGPT 按所选比例发送像素：`1:1`→`1024x1024`，`16:9`→`1536x864`，`9:16`→`864x1536`，`3:2`→`1536x1024`，`2:3`→`1024x1536`，`4:3`→`1024x768`，`3:4`→`768x1024`，`auto`→`auto`。xAI 发送 `aspect_ratio`（含 `auto`）和 `resolution`。Banana 2 发送官方 `aspectRatio` 字符串；`auto` 不带该字段。分辨率映射为 `1K` / `2K`。

改图一张原图，结果写入新文件。未声明 editing 的连接不显示改图按钮。

## 自定义连接

在 Images 页添加：选 `models.json` 里已有的 provider。Flare / Sunburst / Grok 一键带上模型 id 和方言；其他模型仍可手填。密钥和 baseUrl 仍在 Models 里，不在 Images 再存一套。

方言按模型名：`grok-imagine*` 走 xAI 体，其余走 OpenAI Images 体。不要把中转写成第四个品牌。

旧 `images.json` 里不在内置 id 上的条目（例如 Relay Flare / Sunburst / Grok）会在第一次写入 settings 时进 `custom`，之后可在 Images 页改或删。

```json
{
  "version": 1,
  "enabled": true,
  "default": "grok-imagine",
  "connections": {
    "chatgpt-flare": { "enabled": true },
    "chatgpt-sunburst": { "enabled": true },
    "grok-imagine": { "enabled": true },
    "banana-2": { "enabled": true }
  },
  "custom": {
    "gpt-flare": {
      "label": "Relay Flare",
      "provider": "sub2api",
      "model": "gpt-image-2.5-flare",
      "capabilities": {
        "editing": true,
        "sizes": ["auto", "1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"],
        "qualities": ["low", "medium", "high"]
      },
      "defaults": { "size": "auto", "quality": "medium" }
    }
  }
}
```

卡片简称用连接的 `label`。

## 使用

- 对话里提出需求。还没有图时 Agent 文生图；已有图时默认改上一张。只有用户要另开一张无关的图时才设置 `new_image`。
- 输入栏按钮不调用语言模型，直接填提示词和该连接声明的选项。
- 结果卡「改图」打开同一弹窗并绑死原图。引用会把该图作为芯片放进输入栏。

`generate_image` 出现在除“仅聊天”以外的工具预设中；输入栏按钮在所有预设中都可以用。Chat-only 会话仍可通过按钮走直接生成命令。
