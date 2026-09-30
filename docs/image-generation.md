# 生图

Pi Web 内置生图：输入栏按钮、结果卡（改图 / 引用 / 下载）、一个 `generate_image` 工具。结果写入当前工作目录的 `.pi/generated-images/`。包插件里的同名工具会让位给这个内置工具。

默认关闭。打开后才注册工具、才出现输入栏按钮。对标内置 subagents：扩展工厂一直在，关掉则不注册工具。`pi-antigravity` 自己的工具不受影响。

## 开关

在 Settings → Images：

1. 「启用生图」总开关。改完后需要 `/reload` 当前会话，Agent 才会拿到或丢掉 `generate_image`。输入栏按钮在关掉设置面板后就会更新。
2. 总开关打开后，列出内置连接和自定义连接，每条可单独开关。没登录的仍显示在设置里，但不会出现在生图弹窗里。
3. 弹窗里的连接 = 总开关开 ∧ 该连接 enabled ∧ 对应 provider 已有凭证。关掉 Grok Imagine 不会自动关掉 Relay Grok，它们是两条连接。

「默认连接」可选已启用且有凭证的连接。Agent 未指定 `connection` 时，执行层优先使用默认连接；若其凭证不可用，按内置连接、再自定义连接的显示顺序选下一条可用的连接（改图时须声明 editing）。`size` / `resolution` / `quality` 不参与选路：某连接没声明的值改用该连接自己的默认，不会因此跳过默认连接；只有所有已启用连接都没声明的值才报错。遇到上游凭证失效、配额不足或限流时继续尝试下一条；普通请求错误、超时和用户明确指定连接时不跨连接回退，指定连接时所有参数都必须是它声明过的。输入栏生图弹窗会直接传入用户选定的连接。

工具提示词不写默认连接的 id，只让 Agent 填 `"default"`：Settings 里改默认连接后，执行层当场读到，不必等 `/reload`。

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

改图可带多张原图（上限 5，Codex 与 xAI 的共同上限；xAI 单张走 `image`、多张走 `images`），结果写入新文件。未声明 editing 的连接不显示改图按钮。

## 自定义连接

在 Images 页添加：选 `models.json` 里已有的 provider。Flare / Sunburst / Grok / Banana 2 一键带上模型 id 和方言；其他模型仍可手填。密钥和 baseUrl 仍在 Models 里，不在 Images 再存一套。

方言按模型名：`grok-imagine*` 走 xAI 体，`gemini-*` 走 Gemini API 体（`{baseUrl}/models/{model}:streamGenerateContent?alt=sse`，`x-goog-api-key`，baseUrl 填到 `v1beta`，例如 sub2api 的 `/antigravity/v1beta`；请求体与内置 Banana 2 相同，只是不包 Antigravity 的 project 外壳），其余走 OpenAI Images 体。不要把中转写成新品牌。

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

- 对话里提出需求。模型可见的参数只有 `prompt`、`reference_images`、`connection`、`size`：
  - `reference_images` 必填。`[]` = 纯文生图（生图模型看不到对话）；否则是 1–5 张参考图，按列表顺序发给上游（prompt 里用“第一张/第二张”指代）。每项是工作目录里的路径（生成结果按工具结果里的路径、@ 提到的文件），或 `attachment:N` = 本分支上用户附的第 N 张图，从第一张数起，之后不会移位。用户附件没有路径。
  - 引用用稳定标识而不是“最近第 N 张”：相对编号每生成一张就移位，实测 grok 会因此把同一张图传两次、漏掉原图。
  - 必填而非可选，是实测结果：gpt-6-sol 会把每个可选字段都填上，"省略=新图"会让它在无关请求里也带上旧图。
  - 生成成功后，工具结果（和输入栏直出的 custom message）除了路径还带一张长边 512、≤64KB 的 JPEG/PNG 预览，让模型看得到自己画了什么（“左边那个”“颜色跑偏了”）。预览存在会话里，之后每轮请求都会带上，实测一张约 170 input token；不支持图片的模型由 pi-ai 自动剥掉。界面只显示结果卡，不重复显示预览。
  - `connection` 必填，`"default"` = Settings 里的默认连接加自动回退；只有用户在消息里点名某条连接时才填它的 id（实测 gpt-6-sol / grok-4.7 在写实人像、文字海报等场景都不会自己换）。模型点名的连接只是“优先”：凭证缺失、不支持改图、配额错误都继续按自动选路回退，它没声明的比例改用它自己的默认，所以选错连接不会让调用失败。输入栏弹窗选的连接仍是严格的。
  - 分辨率、质量不给模型，用所选连接的默认值；`size` 是按已配置连接生成的枚举。参数错误的报错会指出正确写法，Agent 可据此改一次。
- 输入栏按钮不调用语言模型，直接填提示词和该连接声明的选项。
- 弹窗可粘贴、拖入或选原图（可多张，与结果卡绑定的原图合计最多 5 张），此时变为改图，只列出声明 editing 的连接。多张时缩略图按发送顺序标 1、2、3，提示词可直接说“图 1 的外套穿到图 2 的人身上”。打开弹窗时输入栏里已粘贴的图会一并带上，生成成功后从输入栏移除。原图先存进 `.pi/generated-images/`，再作为 `reference_images` 发送。
- 结果卡「改图」打开同一弹窗，该结果固定为第 1 张，可再添加原图。引用会把该图作为芯片放进输入栏。

`generate_image` 出现在除“仅聊天”以外的工具预设中；输入栏按钮在所有预设中都可以用。Chat-only 会话仍可通过按钮走直接生成命令。
