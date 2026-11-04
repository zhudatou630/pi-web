# 子代理池故障切换：调研与设计

v1 已按下文实现（schema + 运行时故障切换 + AgentEditor 有序多选 + i18n + 文档合并为一个 PR）。开放问题一律采用 §4 的推荐项，并在代码里保持可调整（冷却时长 `SUBAGENT_POOL_COOLDOWN_MS`、总尝试上限 `subagentPoolMaxAttempts`、切换分类正则）。

v1 落点：客户端安全的 schema 在 `lib/subagent-pool-schema.ts`（AgentEditor / session-reader / MessageView 只引用它，不引用 pi-ai）；引擎在 `lib/subagent-pool.ts`；spawn/resume 在 `lib/subagent-runtime.ts`（`registerSession` 之后安装，缺 runtime 安全 no-op）；有序多选在 `components/AgentEditor.tsx`。§5 建议的 4 个 PR 已合并进这一份。

调研结论来自实现时的 worktree（分支 `feat/subagent-pool-failover`，基于 `origin/main` `be7d31a`，`@earendil-works/pi-*@1.5.0`）源码与已安装 SDK。

维护者 Geek（GitHub XR-Lee）原话：

> 希望在子代理里面能够 多选账号和模型 在子代理上游异常时切换不同的子代理池的别的选择

即：在 pi-web 的子代理配置里多选账号（provider 凭据 / API key / 登录账号）和模型，组成「子代理池」；子代理调用上游出错时，自动切到池中另一个选择继续。

---

## 1. 调研

### 1.1 子代理在 pi-web 里怎么实现

子代理**不是** pi SDK 自带功能，也**不是**要用户安装的 pi 插件。它是 pi-web **自己的内联隐藏扩展**，在父会话启动时挂进 SDK 的 `AgentSession`。

证据：

- 扩展名 `pi-web-subagents`，`hidden: true`，工厂为 `createSubagentExtension()`（`lib/subagent-extension.ts:17-18`、`238-246`）。
- 父会话在 `startRpcSession()` 的 `extensionFactories` 里安装它，并用 `preferPiWebSubagentExtension()` 压掉遗留 npm 包 `pi-subagents`（`lib/rpc-manager.ts:2722-2739`；`lib/subagent-extension.ts:471-489`）。
- 全局开关 `~/.pi/agent/agents/settings.json` 的 `builtInEnabled`（默认 true）。关掉则工厂不注册工具；打开则识别并移除注册了保留工具名的遗留 `pi-subagents`（`docs/adr/0003-built-in-subagent-toggle.md`；`docs/subagents.md:5-9`；`AGENTS.md:125-129`）。
- 真正拉起子会话的是 `createSubagentController()`（`lib/subagent-runtime.ts:964`）。进程级单例挂在 `SUBAGENT_CONTROLLER`（`lib/rpc-manager.ts:2030-2054`）：`getSession` / `registerSession` / `reopenSession` 都走 pi-web 的 `AgentSessionWrapper` 注册表。

工具面（父模型可调用，`exposure: "model-only"`，不能被 `ctx.executeTool()` / codemode 调）：

| 工具 | 作用 |
| --- | --- |
| `Agent` | 按 profile 新建或 `resume` 子会话 |
| `get_subagent_result` | 读结果；`wait=true` 在本轮内 join |
| `steer_subagent` | 给正在跑的子代理塞转向消息 |
| `abort_subagent` | 停掉排队/运行中的子代理 |

配置面：

| 路径 | 作用 |
| --- | --- |
| `~/.pi/agent/agents/*.md` | 全局 profile（与 CLI 共享目录） |
| `<cwd>/.pi/agents/*.md`、`.agents/agents/*.md` | 项目 / workspace |
| `~/.pi/agent/agents/settings.json` | 内置开关、`maxConcurrent`、按项目覆盖 |
| `GET/PUT/PATCH/DELETE /api/subagents/profiles` | 读写 profile（`app/api/subagents/profiles/route.ts`） |
| `GET/PUT /api/subagents/settings` | 开关与并发（`app/api/subagents/settings/route.ts`） |
| `GET/POST /api/subagents/:id` | 读 live run；steer / abort（`app/api/subagents/[id]/route.ts`） |
| `components/AgentsConfig.tsx` + `AgentEditor.tsx` | Agents 页与 Project 页共用同一套编辑器 |

profile 文件是带 YAML frontmatter 的 markdown。pi-web **托管**的键是固定集合（`lib/subagents.ts:134-146`）：

`description`, `display_name`, `tools`, `load_skills`, `load_extensions`, `enabled`, `inherit_context`, `run_in_background`, `model`, `models`, `thinking`, `max_turns`

其余键（`name`, `allowed_subagents`, `exclude_extensions`, `disallowed_tools`, `prompt_mode`, `isolation`, …）保存时原样 round-trip（`lib/subagents.ts:293-298`、`573-576`；`docs/subagents.md:11-12`）。这是为了和 CLI / 其他 runtime 共享同一批 `*.md`。

内置三个 profile：`general-purpose`、`explore`、`plan`（`lib/subagents.ts:151-191`），**都不写 `model`**，子代理默认跟父会话当前模型。

一次 `Agent` 调用的运行时路径（新建）：

1. `Agent.execute` → `runtime.start`（`lib/subagent-extension.ts:319-335`）。
2. `resolveSubagentProfile`；解析模型；写子会话 JSONL（`pi-web:subagent` metadata + `queued` 状态）（`lib/subagent-runtime.ts:973-1089`）。
3. 按父会话排队（`SubagentQueue`，FIFO per parent，默认最多 10 个并发，`lib/subagent-queue.ts:24-36`；`lib/subagent-settings.ts:21-22`）。
4. `createAgentSessionServices` + `createAgentSessionFromServices` 建子 `AgentSession`，**复用父会话的 `ModelRuntime`**（`lib/subagent-runtime.ts:1120-1168`）。
5. `dependencies.registerSession` 把它包成 `AgentSessionWrapper`（和主会话同一套事件/SSE/Stop 基础设施）（`lib/rpc-manager.ts:2032-2044`）。
6. `inner.prompt(task)`（`lib/subagent-runtime.ts:862-926`）。结束用 `deriveSubagentOutcome()` 映射成 `completed` / `failed` / `aborted`（`lib/subagent-runtime.ts:177-229`）。

`resume` 明确保留子会话已有的模型、thinking、工具、上下文、隔离和轮次上限，拒绝 `model` / `thinking`（`lib/subagent-extension.ts:293-294`；`docs/subagents.md:29`）。

**和 SDK / 插件的边界：**

- `@earendil-works/pi-coding-agent` 提供 `AgentSession`、扩展 API、`registerTool`、会话文件、模型运行时。它**没有**子代理池，也没有内置 `Agent` 工具。
- 遗留扩展 `@tintinweb/pi-subagents` 仍可在内置开关关闭时使用；打开内置实现后会被压制（`docs/adr/0003-built-in-subagent-toggle.md:28-37`）。
- SDK 1.5.0 有实验性 **virtual model**（`pi.registerVirtualModel` / `ModelRuntime.registerVirtualModel`，见 `node_modules/@earendil-works/pi-coding-agent/docs/virtual-models.md`）。pi-web **当前没有使用**（仓库内 `registerVirtualModel` 零引用）。

### 1.2 账号（auth）和模型现在怎么选

#### 主会话

- 模型来自 `ModelRuntime`（`models.json` + 内置目录 + 扩展注册的 provider），选择面受 `settings.json` 的 `enabledModels` 约束（`lib/model-scope.ts:13-20`、`79-86`）。
- 登录态来自 `~/.pi/agent/auth.json`。SDK 契约写死：**按 `Provider.id` 一把钥匙**（`node_modules/@earendil-works/pi-ai/dist/auth/types.d.ts:31-32`、`43-49`；`docs/settings.md:46`；`AGENTS.md:133`）。
- 双认证 provider（例如 Anthropic API key 与 Claude Pro/Max OAuth）也只能存一种，UI 在 API key 列表和 OAuth 列表里只出现一次（`lib/provider-listing.ts:14-15`、`73-80`）。
- 保存/删除走 `/api/auth/api-key/[provider]` 和 OAuth login 流，底层 `storeProviderCredential` / `removeStoredCredentialIfType`（`lib/provider-credential-store.ts:76-85`、`93-114`）。
- 自定义 `models.json` provider 可以自带 `apiKey`，从而以**另一个 provider id** 再放一把钥匙（`node_modules/@earendil-works/pi-coding-agent/docs/models-configuration.md:9-17`）。这是今天唯一能「同一厂商两把 key」的办法。

**结论：pi 与 pi-web 都不支持「同一 provider 多个凭据」。所谓多账号，在现有数据模型里等于多个已配置、已登录的 provider id（内置登录 + 自定义网关/中转）。**

#### 子代理

profile 只有**一个**可选字符串 `model`（`lib/subagents.ts:38`、`391`）。编辑器是单选 `ModelSelector`，空值文案是「跟随父会话」（`components/AgentEditor.tsx:565-577`；`lib/i18n/messages/zh-CN.ts:464-468`）。

解析规则 `parseSubagentModel()`（`lib/subagent-runtime.ts:278-306`）：

- 接受 `provider/id`、唯一的裸 `id`、以及 pi 的 `:thinking` 后缀。
- **父模型通过 `Agent.model` 指定时**：只允许落在当前会话的 `enabledModels` 范围（`<subagent_models>` 里列出的那批，最多 40 个，`lib/subagent-extension.ts:148-170`、`287`）。
- **profile 自己的 `model`**：按用户配置处理，对照 **全部已配置模型** 解析（`lib/subagent-runtime.ts:997-1005`；`docs/subagents.md:29`）。
- 都没有：子会话用 `parent.inner.model`（`lib/subagent-runtime.ts:1009`）。
- 解析失败直接抛错并列出可选值，**不会静默 fallback**。解析发生在创建子会话文件之前，避免留下空 run。

`Agent` 工具描述里每个 profile 最多写一句 `Default model: …`（`lib/subagent-extension.ts:116`）。没有账号字段，也没有列表。

子会话 **share 父会话的 `ModelRuntime`**（`lib/subagent-runtime.ts:995`、`1123`），因此看到同一份目录和同一份 `auth.json`。在共享 runtime 上 `registerVirtualModel` 会进父会话的模型列表。

### 1.3 现有重试 / 错误处理

#### SDK 自动重试（同一模型、同一凭据）

`AgentSession._handlePostAgentRun`：若最后一条 assistant 是可重试错误，则 `_prepareRetry`（`node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:1549-1576`、`3058-3143`）：

1. 看 `settings.retry.enabled`（默认 true）和 `maxRetries`（默认 3）（`schemas/settings.schema.json:166-180`）。
2. 指数退避 2s / 4s / 8s，封顶 `maxAgentDelayMs`（默认 60s）。
3. `_omitRecoveryAttempt` 把失败的 assistant（及其 tool result）从**模型投影**里拿掉，原文仍留在 JSONL 里（同文件 `851-884`、`3128`）。
4. 发出 `auto_retry_start` / `auto_retry_end`。成功的 `auto_retry_end` 要等重试后的第一条完整回复，可能很久（`hooks/useAgentSession.ts:1540-1541`）。
5. `agent.continue()` 用同一条用户消息再打一枪。上下文延续，不新增 user 消息。

可重试分类是 `isRetryableAssistantError()`（`@earendil-works/pi-ai/dist/utils/retry.js:205-211`）：

- 必须 `stopReason === "error"` 且有 `errorMessage`。
- **排除**配额/账单（`insufficient_quota`、`quota exceeded`、`billing`、ChatGPT 共享额度、Z.ai 1308 等，同文件 `4-28`）。
- **包含** overloaded、429、500/502/503/504/520/524、timeout、网络/fetch 失败、upstream 断开、websocket 关闭等（同文件 `29-108`）。
- **不包含** 401、403、`unauthorized`、`invalid_api_key`。鉴权失败今天**不会**自动重试。
- 上下文溢出走 compaction，不是 retry（`agent-session.js:3058-3061`）。

Abort 永不重试（`retry.js:158-162`）。用户 Stop 有时被存成 `stopReason: "error"` 且文案是 `This operation was aborted`；pi-web 用 `isAbortedAssistantError()` 认出来（`lib/message-display.ts:109-117`）。

#### pi-web 对分类器的补丁

`lib/retry-stream-drops.ts` 猴子补丁私有方法 `_isRetryableError`，把 SDK 漏掉的 HTTP/2 stream drop 也标成可重试。只把 false→true，绝不反过来。`AgentSessionWrapper` 构造时对**每个**会话（含子代理）都打这个补丁（`lib/rpc-manager.ts:382`；`AGENTS.md:66`）。改名会让补丁变 no-op，有测试钉死方法名。

#### 子代理如何上报失败

`deriveSubagentOutcome()`（`lib/subagent-runtime.ts:177-229`）：

| 情况 | 结果 |
| --- | --- |
| abort / `stopReason === "aborted"` | `aborted`（保留已有文本） |
| `stopReason === "error"` | `failed`，`error` = provider `errorMessage` |
| `stopReason === "length"` | `failed`，「output limit」 |
| `prompt()` 抛错 | `failed`，thrown message |
| 轮次用尽且没最终答复 | `failed` |
| 正常文本 | `completed` |

失败的 `Agent` 工具结果带 `details`（子会话 id）并标 `isError: true`（`lib/subagent-extension.ts:255-261`）。后台失败进父会话的 wave 通知，文案含 `[Subagent failed: …]`（同文件 `233-235`）。**没有任何「换一个模型再试」的路径。** SDK 重试耗尽后，子代理就失败。

子会话是完整 `AgentSessionWrapper`，打开子标签页时走同一套 SSE。`auto_retry_start` 会驱动 `retryInfo` 横幅「正在重试（n/m）…」（`hooks/useAgentSession.ts:428`、`1772-1777`；`lib/i18n/messages/zh-CN.ts:842`）。父会话看不到子会话的 retry 横幅。

排队/启动失败（未知 profile、目录不存在、worktree 创建失败）走 `failedRun()`，到不了模型层。

#### 已有的「池」先例：生图 connections

`executeImageGeneration` 按 connection 列表顺序试；401/402/429 和 quota/rate-limit 文案会试下一个，严格用户指定则不 fallback（`lib/image-generation-runtime.ts:241-292`）。这是 **单次 HTTP 调用** 的循环，不是多轮 agent。子代理不能照搬这个循环，但「可切换错误 vs 严格模式」的分类值得对齐。

### 1.4 故障切换应该放在哪

| 方案 | 结论 |
| --- | --- |
| **pi-web 服务端子代理运行时（推荐）** | 子代理本就是 pi-web 内联扩展。模型在 spawn 时选定（`lib/subagent-runtime.ts:1003-1164`），失败在 `promptSubagent` / `deriveSubagentOutcome` 收口。GUI 已在 `AgentEditor`。父/子共享 `ModelRuntime` 与 `AgentSessionWrapper`。补丁 `_isRetryableError`、包 `streamFunction`（prompt cache TTL）都已有先例。 |
| 做成独立 pi 插件 / 扩展 | **不适合做引擎。** 内置扩展开启时会拿掉注册保留工具名的 `pi-subagents`。插件看不到 Agents 编辑器，也不能安全地往共享 `ModelRuntime` 上挂 virtual model。CLI 用户若需要同等行为，应把 profile 的 `models:` 做成文档化 frontmatter，而不是再做一个抢 `Agent` 工具的插件。 |
| 纯 SDK virtual model | 方向正确（`route({ reason: "retry", failed })` 就是为换模型准备的，`docs/virtual-models.md:82-84`），但 v1 不够：① 注册在共享 `ModelRuntime` 上会漏进父会话选择器（virtual model 在无实体 provider 的 id 下「始终 available」）；② 401/配额被分类为不可重试，`reason: "retry"` **根本不会触发**；③ 子会话没有独立 runtime。 |
| 等 pi 上游改 auth.json | 只有「同一 provider 多把 key、不必建自定义 provider」才需要。v1 用现有 catalog 条目（每个 provider id 一把钥匙）就能做池。多凭据是独立上游需求，见开放问题。 |

**GUI 留在 pi-web**（Geek 的要求，也和现在 Agents 页一致）。

**引擎放在 pi-web 的 `lib/subagent-runtime.ts` + 新 helper（例如 `lib/subagent-pool.ts`）**，装在子 `AgentSession` 上，复用 SDK 的 omit-and-continue 重试循环，而不是再 `prompt()` 一条新 user 消息。

不需要为 v1 改 `@earendil-works/pi-*`。若日后 SDK 提供 per-session virtual model 或多凭据 store，再把引擎迁过去。

---

## 2. 设计

### 2.1 目标与非目标

**目标**

- 每个 subagent profile 有一个有序的 `(provider, modelId)` 池。每一项是现有 catalog 里的一个模型，provider id 就是账号/凭据身份。
- 子代理上游失败（限流、5xx、超时、鉴权、该账号配额）时，自动换池里下一个，**同一条子会话**继续，不丢已执行的工具结果。
- 单模型 profile 行为与现在完全一样。
- 与 CLI 共享的 `*.md`：旧读者仍能读 `model:` 标量当默认；不认识的 `models:` 被 round-trip。

**非目标（v1）**

- 主会话 composer 的故障切换。
- 同一 `auth.json` provider 下存多把 key（需 pi 上游）。
- 按账号 × 模型做笛卡尔积（跨 provider 的组合非法，例如 Anthropic 账号 + GPT 模型）。
- 按负载/成本做智能路由（那是 SDK virtual model / jev-router 的事）。
- 把失败的 tool 调用换模型重放。

### 2.2 数据模型（向后兼容）

池成员 = 一条已解析的 catalog 引用，格式与今天的 `model:` 相同：`provider/id`。

#### Frontmatter

现在（继续合法）：

```yaml
model: anthropic/claude-sonnet-4-6
thinking: medium
```

池（新）：

```yaml
model: anthropic/claude-sonnet-4-6          # 默认 / 第一项；旧 runtime 只看这个
models:                                      # 有序池；第一项应等于 model（保存时规范化）
  - anthropic/claude-sonnet-4-6              # 账号 A（auth.json 的 anthropic）
  - my-anthropic-2/claude-sonnet-4-6         # 账号 B（models.json 自定义 provider + 自己的 apiKey）
  - openai/gpt-5.4
thinking: medium
```

不另加 `accounts:`。账号就是 provider id：内置登录、OAuth、或带自己 `apiKey` 的自定义 provider。编辑器按 provider 分组列出模型，用户多选的是「这个账号上的这个模型」。

#### 解析

扩展 `SubagentProfile`（`lib/subagents.ts:27-51`）：

```ts
model?: string;            // 第一项，标量；旧字段
models?: string[];         // 有序池；缺省则 model ? [model] : []（空 = 跟随父会话）
```

规则：

1. `model` 仍是字符串。数组写进 `model:` **禁止**：旧 `stringValue()` 会当成未设置，子代理会错误地继承父模型（`lib/subagents.ts:193-195`、`391`）。
2. `models` 是字符串列表（YAML 序列或逗号分隔，复用 `stringList()`）。去空、去重、保序。
3. 保存时若 `models.length > 0`：把 `model` 写成 `models[0]`（旧 pi-web / CLI 仍有默认）；`models` 整表都写。若只有一项，可只写 `model:`、省略 `models:`，磁盘与现在一致。
4. 把 `models` 加入 `MANAGED_FRONTMATTER_KEYS`。未升级的 pi-web 会把它当 unmanaged round-trip，不丢数据。
5. 解析不查 catalog（和现在的 `model` 一样）。无效项在 **spawn** 时用现有 `parseSubagentModel` 失败。

TypeScript 侧规范化：

```ts
function profilePool(profile: SubagentProfile): string[] {
  const listed = profile.models?.length ? profile.models : (profile.model ? [profile.model] : []);
  if (profile.model && listed[0] !== profile.model) {
    return [profile.model, ...listed.filter((m) => m !== profile.model)];
  }
  return listed;
}
```

空池 = 今天的「跟随父会话」。

#### 运行时解析（spawn）

在 `createSubagentController.start` 里，替换单次 `parseSubagentModel`（`lib/subagent-runtime.ts:1003-1009`）：

1. `poolRefs = profilePool(profile)`。
2. 父模型传了 `request.model`：把它解析到 **scoped choices**，放进池首（已在则移到最前）。这保留「用户点名的模型优先」，其余当后备。
3. 其余 refs 按 profile 规则解析（全目录）。解析失败的项跳过并记一条 spawn 诊断；**全部**失败则抛现有的 `Subagent model not found` 错。
4. 池为空：`childModel = parent.inner.model`（现在的 inherit）。
5. `childModel = resolved[0]`，整表交给 session-local failover installer。
6. thinking：仍是 `request.thinking ?? suffix ?? profile.thinking ?? parent`；换成员时按新模型能力 clamp（`AgentSession.setModel` 已做，`agent-session.js:2030-2041`）。

`input_files` 字节上限仍按 **第一项** 的 context window 算（`lib/subagent-runtime.ts:1007-1021`）。换到更小窗口的模型时，SDK 会在下一请求前 compaction（`agent-session.js:437-444`）。

#### 元数据

不必改 `SubagentMetadata` 的 version（`lib/subagents.ts:53-68`）。池来自 profile，resume 再读一次。可选：在 metadata 里加 `pool?: string[]` 快照，避免 resume 时 profile 已改。**推荐快照**：子会话必须按启动时的池跑，和 tools/system prompt 的 `resourceSnapshot` 同一理由。

新 custom entry（子 JSONL，模型不可见）：

```ts
// customType: "pi-web:subagent-pool-switch"
{
  version: 1,
  from: { provider: string; id: string };
  to: { provider: string; id: string };
  error: string;          // 截断后的 errorMessage
  reason: "auth" | "quota" | "transient" | "timeout";
  memberIndex: number;
}
```

Agents 列表已经从 `model_change` 和 assistant 消息读当前模型（`lib/session-reader.ts:185-193`）。`setModel` 会追加 `model_change`（`agent-session.js:2033`），popover 会更新。custom entry 是给人看的「为什么换了」。

### 2.3 切换触发条件

只处理 **模型请求** 失败（assistant `stopReason === "error"` 带 `errorMessage`）。工具执行、用户停止、编排失败不切。

#### 切

在还有未尝试（或已过冷却）的成员时：

1. **瞬态 / 上游** — `isRetryableAssistantError` 为 true 的（429、5xx、overloaded、timeout、网络、upstream 断开）。当前成员先走完 SDK `settings.retry` 预算，**然后**换成员。
2. **鉴权** — 401/403（数字要有边界，与 SDK 对 429 的做法相同）、`unauthorized`、`invalid_api_key`、`authentication failed`、`No API key for`。这类 SDK **不会**重试；有后备时必须当成可重试并 **立刻**换成员（不要对死 key 退避 2s/4s/8s）。
3. **该账号配额 / 账单** — `NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN` 对**同一**账号是对的，但换账号正是 Geek 要的。有其他成员时覆盖为可切换。生图路径已对 401/402/429/quota 这样 fallback（`lib/image-generation-runtime.ts:290`）。

分类实现：新 helper `isSubagentPoolSwitchableError(message, { hasRemainingMember })`，内部调用公开的 `isRetryableAssistantError`，加上鉴权/配额。配额探测复用 `retry-stream-drops.ts:11-13` 的手法（给文案追加 `503` 再问分类器，避免复制私有正则）。

#### 不切

| 情况 | 原因 |
| --- | --- |
| 用户 Stop / `abort_subagent` / `stopReason === "aborted"` / `isAbortedAssistantError` | 明确取消 |
| 工具错误（bash/edit/read 失败、`isError` tool result） | 不是上游模型故障；agent 循环会自己处理 |
| 上下文溢出（`isContextOverflow`） | SDK compaction + 同模型重试；换更小窗口会更糟（见开放问题） |
| `stopReason === "length"`（输出上限） | 今天已经是子代理失败；换模型不能安全重放半截回复 |
| 轮次用尽 | 预算问题，不是 provider |
| 未知 profile、模型名打错、cwd 没了、worktree 失败、排队拒绝 | 到不了模型层 |
| 池耗尽 | `deriveSubagentOutcome` 按最后一次错误失败 |
| 池只有一项（或 inherit 且没有额外成员） | 与现在相同，只有 SDK auto-retry |

### 2.4 切换策略

**默认：有序列表，每成员最多一轮「同模型 SDK 重试」，失败则永不回头（本 run 内）。**

对每个成员 `M`：

1. `setModel(M, { persist: false })`。`persist` 必须是 false，否则会改用户全局默认模型（`agent-session.js:2034-2036`；主会话的 `set_model` RPC 才 `persist: true`，`lib/rpc-manager.ts:1147`）。
2. 瞬态错误：让现有 `_prepareRetry` 在 **这个** 模型上跑 `settings.retry.maxRetries` 次（默认 3，退避 2/4/8s）。
3. 鉴权/配额：不要用满同模型重试；下一次 continue 换下一个。
4. 该成员仍失败 → 标为已用，换下一个。
5. 全部用完 → 正常失败。

**总尝试次数上限**（防止补丁把 `maxRetries` 放大后打爆）：

```
maxAttempts = pool.length * max(1, settings.retry.maxRetries)
```

只存在子会话内存里，不写 `settings.json`。

**冷却（进程内，推荐 v1）：** 成员失败后，key=`provider/id` 冷却 60s。同一父会话下并行的子代理会跳过刚死掉的 key。映射放 `globalThis`（和 `__piSubagentRuns` 一样，热重载能活下来）。不持久化。

**不做 v1：** 跨 run 的 round-robin 负载均衡。顺序 = 用户优先级。

**thinking：** `setModel` 已按新模型 clamp。profile 的 `thinking` 是目标，不是每成员一项。

**并发：** 每个子代理自己的池游标。冷却是唯一的跨 run 协调。

### 2.5 会话 / 上下文如何在切换后延续

关键约束：failover 必须发生在 **同一次** `AgentSession` run 里，这样才会走 `_omitRecoveryAttempt` + `agent.continue()`。`prompt()` 返回后再 `prompt()` 一次会多一条 user 消息，把失败的 assistant 留在上下文里。

SDK 已经保证（auto-retry 路径）：

- 失败的 assistant 仍在 JSONL 里（UI 能看到），但从模型投影中省略。
- 用户任务、已完成的 tool 结果、skill catalog、继承的父上下文都还在。
- `continue` 不新增 user 消息。

因此引擎要 **留在这个循环里**，在 `continue` 发出下一请求之前换模型。

`AgentSession.setModel` 在 run 中途可以调用：它改 `agent.state.model` 并追加 `model_change`（`agent-session.js:2026-2042`）。随后 `prepareRequest` 用 `this.agent.state.model`（同文件 `462-468`）。在 `auto_retry_start` 的退避睡眠期间（或补丁过的 `_prepareRetry` 里、sleep 之后）调用即可。

**粘性 continuation：** 成功的 tool 轮次之后，下一请求是 `continuation`（tool results 进模型）。即使下一枪也失败，先对 **同一** 物理模型做 SDK 重试（thinking signature / prompt cache，virtual-models.md:84）。只有该成员的重试预算用尽才换。换模型会丢 cache，这可接受。

**Resume：** `Agent resume` 保持子会话模型（`lib/subagent-extension.ts:278`、`293-294`）。failover 之后磁盘上的最新 `model_change` 是最后那个物理模型。Resume 从这里开始，**仍然安装完整池**（失败可再切）。不要在 resume 时重置回 `models[0]`——那个账号可能还是坏的。

**打开子标签页：** 用户看到完整 transcript：失败的 assistant 气泡、`model_change`、可选的 `pi-web:subagent-pool-switch`。retry 横幅已经能工作。

### 2.6 引擎安装（子 AgentSession 本地）

新模块 `lib/subagent-pool.ts`，由 `createSubagentController` 在 `registerSession` 之后、`prompt()` 之前调用。不要注册共享 virtual model。

`installSubagentPoolFailover(inner, pool, options)`：

1. `pool.length < 2` 则 no-op（inherit 或单模型 = 今天的行为）。
2. 在已有的 `retryStreamDrops` 补丁之上再包一层 `_isRetryableError`（wrapper 构造时已经打过，`lib/rpc-manager.ts:382`）：
   - 原判断为 true → true。
   - overflow / abort → false。
   - 还有剩余成员且 `isSubagentPoolSwitchableError` → true（这才让 401/配额进入 `_prepareRetry` 而不是直接结束 run）。
3. 包 `_prepareRetry`：
   - 用内存里的 `maxAttempts = pool.length * settings.maxRetries`，不改磁盘。
   - 记每成员尝试次数。
   - 鉴权/配额，或该成员瞬态重试次数已满：在 sleep **之前** `setModel(next, { persist: false })`，追加 `pi-web:subagent-pool-switch`，重置该成员计数。无下一成员 → 返回 false（run 结束）。
   - 瞬态且该成员还有预算：不换模型，走正常退避。
4. `inner.subscribe`：`auto_retry_start` 照常（打开的子标签页横幅）。换模型不需要新的 SSE 类型；多一个 `entry_appended` 即可。
5. 返回 disposer，在子会话 `shutdown` 时拆补丁。

方法名钉死测试，照 `lib/retry-stream-drops.test.mjs`。SDK 改名则 failover 变成 no-op，行为退回「只对瞬态错误同模型重试」——安全失败。

**为什么不包 `streamFunction`：** 半截 stream 的事件分发很复杂；AgentSession 已经把失败收成一条 assistant error。**为什么不用 virtual model：** 共享 `ModelRuntime` 会漏进父选择器；401 也进不了 `reason: "retry"`，除非同样去补丁分类器。

**和 `retryStreamDrops` 的关系：** 只把 false 打成 true。池补丁再包一层。两个都是「有后备时多给一次机会」。

### 2.7 UI

全部在 pi-web。i18n 走 `lib/i18n/messages/{zh-CN,en}.ts`（`docs/i18n.md`）。

#### Agents 编辑器（`components/AgentEditor.tsx`）

「指定模型」那一行改成有序多选，仍用 `ModelSelector` 的选项源（`settingsUrls.chatModels(cwd)`，已有测试 `components/AgentsConfig.test.mjs:35-39`）：

- 空 = 跟随父会话（现在的 `onClear` / `emptyLabel`）。
- 一项 = 只写 `model:`（磁盘与现在相同）。
- 多项 = `model:` + `models:`。
- 选项按 provider 分组（`ModelSelector` 已分组，`components/ModelSelector.tsx:71-77`）。分组标题就是账号身份。
- 顺序 = 优先级。v1 用添加顺序 + 上移/下移；不必上拖拽。
- 不可用的已存项保留并显示「不可用」，和现在的 `agents.modelUnavailable` 一样。
- 帮助文案（中文大意）：同一厂商的第二把 key 请在「模型」设置里加自定义 provider（自带 API key），然后把它的模型加进池。
- `formSnapshot` / dirty 检测必须包含 `models`（`components/AgentEditor.tsx:58-61`、`76-91`）。

不需要单独的账号多选：选 `my-relay/claude-sonnet-4-6` 就是选了那个账号上的那个模型。笛卡尔积会生成非法组合。

#### Agent 工具描述

`agentTypeDescription` 在有池时写 `Default model: a; failover: b, c`（`lib/subagent-extension.ts:116`）。父模型才能把用户点名的模型放进 `Agent.model`。

#### 运行中 / 历史

- Agents popover 已经显示当前物理模型（`components/AgentSessionPanel.tsx:113-116`）。`setModel` → `model_change` → 扫描器更新。
- 打开的子标签页：现有 retry 横幅。可加一句「已切换到 {provider}/{id}」（读最新 pool-switch entry 或 `model_change`）。
- 父侧 `Agent` 卡片：`details` 仍是 session id + status。不必把每次切换打进模型可见文本（会污染父上下文）。人看 transcript。
- 失败文案：最后一次 provider 错误，与现在相同。可选：在 `error` 里加一句「tried a, b, c」。

#### 不改

- 主会话 composer 模型选择。
- `enabledModels` 范围（父点名的模型仍受 scoped choices 限制）。
- profile 文件的托管键 round-trip 规则（只新增托管 `models`）。

### 2.8 测试计划

新文件 `lib/subagent-pool.test.mjs`；扩展现有测试。不测真实 provider。

**schema / IO（`lib/subagents.test.mjs`）**

- 只有标量 `model:` 的 profile：`profilePool` 长度为 1；保存不写 `models:`。
- `model:` + `models:`：保存时 `model === models[0]`，去重保序。
- 只有 `models:`：保存补上 `model: models[0]`。
- 把 `models` 当数组 round-trip；未知键仍保存。
- 旧读者：`stringValue(data.model)` 在有池的文件上仍能拿到第一项。

**解析（`lib/subagent-runtime.test.mjs` 的 `parseSubagentModel`）**

- 逐项解析；坏项跳过；全坏则抛现有错误。
- `Agent.model` 移到队首且仍在 scoped choices 里。
- 空池 → inherit 标记，不调用 parse。

**分类器**

- 429 / 503 / timeout / `fetch failed` → 可切换。
- 401 / 403 / `invalid_api_key` / `No API key for` → 有后备则可切换，没有则否。
- 配额文案 → 有后备则可切换（与裸 `isRetryableAssistantError` 相反）。
- abort 文案、overflow、`stopReason !== "error"` → 否。
- `retry-stream-drops` 的 stream-drop 仍为 true（组合补丁）。

**运行时（mock AgentSession）**

- 单成员：不打补丁；行为与现在相同。
- 成员 A 429 耗尽 `maxRetries`，然后 `setModel(B, { persist: false })` 并 continue；B 成功 → `completed`。
- 成员 A 401 → 第一次 retry 就切到 B（不等 2s×3）。
- 用户 abort → 永不 `setModel`。
- 工具错误 assistant（stopReason stop + toolCalls）→ 不切。
- 池耗尽 → `failed`，error 为最后一次 provider 文案。
- `setModel` 从不带 `persist: true`（断言调用参数）。
- `_isRetryableError` / `_prepareRetry` 改名 → installer no-op，不抛（照 `retry-stream-drops.test.mjs`）。
- 冷却：A 刚失败时，并行第二 run 先试 B。
- resume：从最后的 `model_change` 开始，仍装着池。

**UI（`components/AgentsConfig.test.mjs`）**

- 编辑器绑定 `models` 有序列表，而不只是一个 `ModelSelector` value。
- 清空 → inherit。
- 一项 → 只保存 `model`。

**集成（可选，照 `lib/subagent-runtime.test.mjs` 的 controller fixtures）**

- mock 的 `prompt()` 第一次发 error assistant，第二次（换模型后）发文本 → 父侧 `Agent` 工具 `completed`，子 JSONL 有 `model_change` + pool-switch entry。

### 2.9 实现落点

| 区域 | 文件 |
| --- | --- |
| schema | `lib/subagents.ts`（类型、parse、save、`MANAGED_FRONTMATTER_KEYS`） |
| 池逻辑 | 新 `lib/subagent-pool.ts`（规范化、分类器、installer） |
| spawn / resume | `lib/subagent-runtime.ts`（解析池、install、metadata 快照） |
| 工具描述 | `lib/subagent-extension.ts`（`agentTypeDescription`） |
| 编辑器 | `components/AgentEditor.tsx`、i18n、`AgentsConfig.test.mjs` |
| 文档 | `docs/subagents.md` 短节 |
| 测试 | `lib/subagent-pool.test.mjs`、扩展 `subagents.test.mjs` / `subagent-runtime.test.mjs` |

API 路由不必为池新增：profile 仍走 `PUT /api/subagents/profiles`。`SubagentProfile` JSON 多一个可选 `models?: string[]`。

---

## 3. Key Decisions

1. **引擎放在 pi-web 子代理运行时，不做成 pi 插件，v1 不改 pi 上游。** 子代理已经是内联扩展；插件会被内置实现挤掉，也没有编辑器。
2. **池成员是有序的 `provider/id` catalog 条目，不是账号 × 模型笛卡尔积。** Provider id 就是账号。非法跨厂商组合进不了池。
3. **保留标量 `model:`，新增可选 `models:`。** 禁止把 `model` 改成数组（旧 `stringValue` 会当成 inherit）。保存时 `model === models[0]`。
4. **复用 SDK omit-and-continue 循环**（补丁 `_isRetryableError` + `_prepareRetry` + `setModel({ persist: false })`）。不在 `prompt()` 返回后再开一轮。失败回复从模型投影中拿掉，工具历史留下。
5. **有后备时，鉴权和配额视为可切换**，即使 SDK 认为不可重试。这是「多账号」相对「同 key 重试」的核心差异。
6. **v1 不在共享 `ModelRuntime` 上注册 virtual model。** 会漏进父选择器，且解决不了 401。
7. **同一 provider 的第二把 key 继续用自定义 `models.json` provider。** 文档写清楚。auth.json 多凭据是上游课题。
8. **Resume 从最后成功的物理模型起步，仍装着整个池。** 不重置回 `models[0]`。

---

## 4. 需要 Geek 决定的开放问题

1. **`Agent.model` 与池的关系。** 推荐：点名的模型移到队首，其余仍是后备。备选：有池时忽略 `Agent.model`；或点名的模型必须属于池否则报错。
2. **同一厂商两把 API key 的 UX。** v1 = 自定义 provider + 文案提示。是否值得做 pi-web 专用的额外 key 存储（不进 `auth.json`，spawn 时注入）？这会偏离「与 CLI 共享 `~/.pi/agent`」，不推荐，除非你明确要。
3. **笛卡尔积 vs 成对多选。** 原话「多选账号和模型」两种读法都通。推荐成对多选。若你要「选 2 个账号 × 选 3 个模型」，请只对**同一 provider 的账号**做乘积。
4. **上下文溢出是否切到 context window 更大的成员。** 推荐 v1 不切（交给 compaction）。
5. **冷却时长与范围。** 推荐进程内 60s，key 为 `provider/id`。备选：不冷却；或写进 `agents/settings.json`。
6. **Resume 从哪一项开始。** 推荐最后成功的成员。备选：永远从 `models[0]`。
7. **是否把池快照进 `SubagentMetadata`。** 推荐是（和 tools snapshot 一致）。备选：每次 resume 再读 profile（改 profile 会影响进行中的孩子）。
8. **Round-robin 负载均衡。** 推荐 v1 不做，严格按用户顺序。限流场景下 round-robin 更有用，可做后续。
9. **父模型是否应看到切换。** 推荐不把切换写进 `Agent` 工具文本。备选：在结果里加一行 tried/switched。
10. **主会话是否稍后用同一套池机制。** 本设计明确非目标。若你想要 composer 级 failover，应走 SDK virtual model（选一次，每请求 route），而不是 subagent profile。

---

## 5. PR Plan

### PR 1 — profile schema 与 round-trip

- **标题：** `feat(subagents): add ordered models pool to agent profiles`
- **文件：** `lib/subagents.ts`、`lib/subagents.test.mjs`、`docs/subagents.md`（schema 段）
- **依赖：** 无
- **内容：** `models?: string[]`；parse/save 规范化；`model` 仍是标量；托管键；单模型文件字节级稳定。无运行时行为变化。

### PR 2 — 编辑器多选

- **标题：** `feat(subagents): multi-select failover models in agent editor`
- **文件：** `components/AgentEditor.tsx`、i18n、`components/AgentsConfig.test.mjs`
- **依赖：** PR 1
- **内容：** 有序多选 UI；inherit / 单 / 多；帮助文案指向自定义 provider。仍不切换。

### PR 3 — 运行时 failover 引擎

- **标题：** `feat(subagents): fail over across profile model pool on upstream errors`
- **文件：** `lib/subagent-pool.ts`、`lib/subagent-pool.test.mjs`、`lib/subagent-runtime.ts`、`lib/subagent-extension.ts`（描述字符串）、`lib/subagent-runtime.test.mjs`
- **依赖：** PR 1
- **内容：** installer、分类器、spawn/resume 接线、metadata 快照、`pi-web:subagent-pool-switch`、冷却。可与 PR 2 并行。

### PR 4 — 可见性与文档

- **标题：** `feat(subagents): surface pool switches in child session UI`
- **文件：** 子标签页 retry/notice 文案（若 PR 3 的横幅不够）、`docs/subagents.md`、`AGENTS.md` 一行陷阱（`setModel` persist false；共享 ModelRuntime 禁止 virtual model）
- **依赖：** PR 3，最好也依赖 PR 2
- **内容：** 打开子会话时能看出发生了切换；文档写清账号 = provider id。
