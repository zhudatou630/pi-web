---
项目名: Pi Web built-in subagents vs @tintinweb/pi-subagents
领域: AI 编程代理的子任务编排
技术栈: TypeScript, pi AgentSession, Next.js, pi extensions
核心概念: 子会话, 任务生命周期, 上下文隔离, 结果交付, 并发控制
关联项目: pi-web-agegr
研究版本: @tintinweb/pi-subagents 0.19.0, pi-web current worktree
研究日期: 2026-09-08
---

# Pi Web 内置 Subagent 与 tintinweb/pi-subagents 对照

## 结论

Pi Web 内置实现不是 tintinweb 的移植版，而是借用了它最早期的交互合同：

- `Agent`
- `get_subagent_result`
- `steer_subagent`
- profile 文件
- foreground/background
- 独立 AgentSession

随后两者走向不同：Pi Web 把子 agent 做成普通、持久、可切换的 Web 会话；tintinweb 在 AgentSession 外建立完整 AgentManager，把子 agent 做成可排队、可消费、可恢复、可分组通知的任务对象。

当前本机安装的是 tintinweb `0.19.0`。它很可能已经比 Pi Web 最初参考的版本发展了很多，因此下面是当前对当前的比较，不是历史源码血缘判定。

## 宏观架构

### Pi Web

```text
父 AgentSession
  -> Agent 工具
  -> createSubagentController
  -> 新建持久 SessionManager + AgentSession
  -> 注册进 Pi Web 全局 RPC registry
  -> 子会话进入 sidebar / AgentSessionPanel
  -> 结果写入子会话 pi-web:subagent-result
```

核心所有权在“会话”：子 agent 从创建开始就是一个可浏览、可继续对话、可独立恢复的正常 Pi Web session。

### tintinweb

```text
父 extension
  -> Agent 工具
  -> AgentManager record
  -> 排队 / 并发池 / 生命周期
  -> createAgentSession
  -> widget / FleetView / viewer / notification
  -> consume / resume / tombstone
```

核心所有权在“任务记录”：AgentSession 是执行载体，AgentRecord 才是状态、通知、排队、恢复和 UI 的权威对象。

## 主要区别

| 维度 | Pi Web 内置 | tintinweb 0.19.0 |
|---|---|---|
| 产品定位 | Web 会话体系的一部分 | 独立、跨宿主的 Pi extension |
| 核心对象 | 持久子 session | AgentManager 中的 AgentRecord |
| 执行方式 | 同进程独立 AgentSession | 同进程独立 AgentSession |
| 默认模式 | foreground | background |
| 后台结果 | 当前工作区改为显式 `get_subagent_result`，不唤醒父模型 | 自动 follow-up 通知父模型 |
| 通知去重 | 不自动通知，因此不需要 consume | `resultConsumed` + 200ms hold，查询后取消通知 |
| 多任务通知 | 无模型通知 | smart/group/async join，默认合并同轮任务 |
| 并发 | 每父会话最多 4 个，超过直接拒绝 | background 默认 10 个并排队；foreground 独立池 |
| 会话持久化 | 始终写普通 Pi session，并保存父关系 | 默认持久，可关闭；另有临时 `.output` transcript |
| 恢复 | Pi Web 直接打开子 session | Manager resume、handle、tombstone 重开 |
| UI | Sidebar 树、AgentSessionPanel、完整 ChatWindow | Widget、FleetView、conversation overlay、`/agents` |
| Profile 来源 | builtin/global/.agents/.pi，项目覆盖 | global/.agents/.pi，项目覆盖 |
| 工具范围 | 内置工具 + 可选全部 extension tools | 内置、扩展选择器、denylist、isolated 等 |
| Skills/extensions | 默认不加载，显式开关 | 默认加载，可精细筛选 |
| 模型选择 | 精确 provider/id，或唯一 bare id | fuzzy resolution + provider fallback |
| 上下文继承 | 整段 messages JSON，50KB 字符截断 | 用户/助手文本 + compaction summary，跳过 toolResult |
| 系统指令 | 所有 profile 都使用独立 prompt 管线 | general-purpose 是 parent twin；Explore/Plan replace |
| 资源复现 | 将实际 prompt/tools/resource policy 写入 snapshot | resume 时重新解析当前 agent definition |
| Turn limit | 一次 wrap-up 后在安全 turn boundary 停止 | 默认 5 个 grace turns，超限 hard abort |
| 状态 | running/completed/failed/aborted/interrupted | queued/running/completed/steered/aborted/stopped/error |
| 高级编排 | 无 | nested、workflow、schedule、mentions、event RPC |

## 各自做得更好的地方

### Pi Web 更好

1. **会话是单一事实来源。** 不需要同时理解 AgentRecord、临时 transcript 和可选 session。
2. **Web 原生可检查。** 子 agent 使用完整 ChatWindow，历史、工具、文件、统计和停止能力自然复用。
3. **恢复可复现。** resourceSnapshot 保存当时实际使用的系统提示、工具和资源开关；未来 profile 改动不会悄悄改变旧子会话。
4. **默认更克制。** foreground、extensions off、skills off、精确模型解析，行为更可预测。
5. **当前结果交付更完整。** background 不再自动生成迟到的父模型回合，主回答保持一个逻辑整体。

### tintinweb 更好

1. **任务状态比会话状态更完整。** queued、steered、stopped、resultConsumed 都有明确语义。
2. **上下文边界更合理。** 项目指令与对话上下文分开处理；对话继承不塞 toolResult 和原始 JSON。
3. **结果生命周期更成熟。** foreground 自动消费；显式查询消费结果；后台通知发送前再次检查，避免重复交付。
4. **并发和停止覆盖更全面。** 排队、启动中、运行中、恢复时都有统一 manager 所有权。
5. **非正常结果表达更诚实。** 用户停止、turn-limit wrap-up、hard abort、provider error 和 partial output 分开表达。

## 值得优化的地方

### P1：优化 `inherit_context` 的内容，而不是扩大容量

Pi Web 当前把 `buildSessionContext().messages` 整体 `JSON.stringify`，然后按 50KB 字符截断。这会带入工具结果、结构字段甚至大块无关内容，截断点也没有语义。

建议借用 tintinweb 的原则：只保留用户文本、助手文本和 compaction summary；跳过 toolResult、thinking、图片 payload 和 UI custom message。容量仍可维持现有限制。

这是最值得做的一项：改动局部，减少 token 浪费，也让子 agent 看到的是“讨论和决定”，而不是会话存储格式。

### P1：让 general-purpose 获得项目指令

Pi Web 对所有子 agent 都设置 `noContextFiles: true`。内置 general-purpose 的系统提示只有一句通用说明，因此它不会自然继承主 agent 读取到的 AGENTS.md/项目约束。

建议采用 tintinweb 的分层判断，但不必复制完整 `prompt_mode` 功能：

- 内置 general-purpose 默认加载当前 cwd 的 context files，成为项目规则意义上的 parent twin；
- Explore 和 Plan 继续使用独立、只读、精简 prompt；
- 不直接复制父 system prompt，避免把父会话的工具列表和主 agent 专用指令错误带入子会话。

这是正确性和安全性问题，不是增强功能。

### P2：记录“因 turn limit 收尾”

当前 Pi Web 能正确保留收尾文本，但只要有最终文本就标 completed。用户无法区分自然完成与被限额催促后收尾。

可以借 tintinweb 的 `steered` 思路，采用一个轻量 `wrapped`/`limited` 标记或详情字段。无需增加 grace-turn 配置；只需要让 UI 和 `get_subagent_result` 不把两种完成说成同一件事。

### P2：配置错误不要静默消失

Pi Web 当前遇到 malformed profile 会直接跳过，未知工具名会被静默过滤。建议只增加诊断：Agents 设置页显示文件和错误原因；不必引入 tintinweb 的 strict mode、复杂 selector 或 fallback agent。

### 条件项：UI-only 的后台完成提醒

如果实际使用证明用户经常忘记后台任务，可以给子 session 增加 unread/browser completion 提示，但不要触发父 LLM。Pi Web 已有 session running/unread 基础设施，这比恢复自动 follow-up 更符合 Web 产品。

## 不建议照搬

1. **自动 follow-up + smart join + consume。** tintinweb 已把这条路修得很完整，但它仍然承认“后台结果会开启后续父模型回合”。这适合 TUI 自主编排，不适合 Pi Web 当前强调完整主回答的体验。
2. **background 默认。** 没有自动模型通知后，foreground 默认更符合可预测性；background 应是明确选择。
3. **五个 grace turns。** 成本和结束时间不受控；Pi Web 的一次收尾轮更克制。tintinweb 最终仍从 `turn_end` 调 abort，当前 Pi Web 的安全边界停止更干净。
4. **完整 AgentManager 和双并发池。** 当前上限 4 的硬拒绝简单可见；没有真实排队需求前，不值得引入 queue gate、startup map、record cleanup 和 tombstone。
5. **Nested agents、Workflow、Schedule、Agent mentions、Memory、cross-extension RPC。** 都是独立产品能力，不是当前机制缺陷的修复。
6. **重复 `.output` transcript。** Pi Web 已有完整 JSONL 子 session，再写一份会产生双事实来源。
7. **默认加载全部 skills/extensions。** Pi Web 的显式开关更适合可控、可复现的 Web 运行时。
8. **模糊模型 fallback。** 易在用户不知情时换 provider 或模型；Pi Web 的精确失败更可靠。

## 最终判断

Pi Web 不需要追上 tintinweb 的功能面。真正应吸收的是三条设计纪律：

1. 项目指令、对话上下文和任务提示是三层不同信息，不应混成原始 JSON。
2. “自然完成”“限额收尾”“用户停止”“失败”必须如实区分。
3. 后台任务的 UI 通知和父模型继续推理是两件事，不应绑定。

按收益排序，我只建议先考虑：语义化 `inherit_context`、general-purpose 项目指令继承、turn-limit 收尾标记。其余保持现状。