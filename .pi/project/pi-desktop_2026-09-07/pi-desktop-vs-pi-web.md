---
项目名: PI-Desktop
领域: 本地优先 AI 编程智能体工作台
技术栈: Electron, React, TypeScript, Rust host-core, pi-agent-core
核心概念: 三栏工作台, 会话隔离, 渐进披露, Work Panel, 全局查找
关联项目: pi-web-agegr
研究版本: 1d94d8ad38e53562187be2e246d798835b558b92
研究日期: 2026-09-07
---

# PI-Desktop 对 Pi Web 的可借鉴点

## 结论

PI-Desktop 最值得借鉴的不是它的功能总量，也不是 Apple/Codex 风格外观，而是它处理复杂度的方式：**主流程只露出必要控制，低频能力收进稳定入口，产物紧贴产生它的那一轮任务。**

我们的 Pi Web 在能力上已经不弱于它，甚至在 Web/PWA、移动端、Chat 标签与分屏、Worktree、终端、文件预览、会话内分支、Steer/Follow-up 等方面更强。当前瓶颈不是缺功能，而是已有能力开始争夺顶部栏、Composer 和 Sidebar 的注意力。

因此建议只做三类渐进变化：

1. **收入口**：减少顶部栏和 Composer 的并列控制；
2. **提结果**：把“本轮改了什么”从日志提升为轻量任务产物；
3. **补发现性**：改善模型查找、空状态和跨区域导航。

不建议照搬它的 Plan/Goal、权限卡、通知中心、插件面板运行时、PR/定时任务、内嵌浏览器或项目资产库。

---

## 一、PI-Desktop 到底是什么

### 宏观架构

PI-Desktop 是一个本地 Electron 工作台，不是简单聊天壳：

```text
React Renderer
  ├─ Sidebar：项目与会话
  ├─ Main Chat：消息、工具过程、Composer
  ├─ Work Panel：Review / Files / Browser / 插件视图
  └─ Settings / Search / Notifications
            │
Electron Main：原生窗口、文件、浏览器视图、插件宿主、权限边界
            │
Rust host-core：会话、存储、RPC、恢复
            │
pi agent runtime：模型与工具循环
```

关键模块：

- `apps/desktop/src/App.tsx`：整个工作台布局与导航；
- `apps/desktop/src/components/Sidebar.tsx`：项目、会话和后台活动；
- `apps/desktop/src/components/Composer.tsx`：任务输入与运行配置；
- `apps/desktop/src/components/ChatTranscript.tsx`：长会话和工具过程；
- `apps/desktop/src/components/workpanel/WorkPanel.tsx`：右侧产物工作区；
- `apps/desktop/src/components/SearchDialog.tsx`：会话、页面、设置和命令的统一查找；
- `apps/desktop/electron/main/*`：桌面能力和安全边界；
- `crates/host-core/*`：持久化与宿主 RPC。

### 核心数据流

1. 用户在 Composer 发起任务；
2. Renderer 通过 Electron Main/host-core 启动或续接会话；
3. Agent runtime 流式返回消息、工具与状态事件；
4. Transcript 展示过程，文件修改同时形成 Review 产物；
5. 产物在当前会话的 Work Panel 中打开，后台会话不会抢走当前焦点；
6. 会话、运行状态、面板上下文和通知都按 session 隔离。

### 它真正有价值的设计判断

PI-Desktop 的 ADR 里反复出现“删掉重复入口”的决定：

- ADR 0017：删除 Composer 上重复且被动的项目/Local/branch rail；
- ADR 0034：把命令面板并入全局搜索，避免两个“找东西”入口；
- ADR 0066：删除空白页快捷操作卡，Composer 固定在底部，第一步直接输入任务；
- ADR 0108：移除内置交互终端，避免维护一套边界不清的子系统；
- ADR 0065：让侧栏/面板真实宽度参与动画，并合并高频流式更新，优先解决“跳”和“卡”，而不是增加装饰。

这说明它最可学的不是“功能丰富”，而是**功能增加后继续做减法**。

---

## 二、与我们的真实差异

### 我们已经有、不要重复造的东西

| 方向 | Pi Web 现状 |
|---|---|
| Chat 标签与分屏 | `components/ChatTabBar.tsx`、`components/AppShell.tsx` |
| 长会话分页和 minimap | `components/ChatWindow.tsx`、`components/ChatMinimap.tsx` |
| 会话全文搜索并跳到消息 | `components/SessionSearch.tsx` |
| 会话 Fork 与树内分支 | `components/BranchNavigator.tsx`、`components/MessageView.tsx` |
| 模型、Thinking、Tool preset | `components/ChatInput.tsx`、`components/ModelSelector.tsx` |
| Steer / Follow-up / 队列撤回 | `hooks/useAgentSession.ts`、`components/ChatInput.tsx` |
| 工具过程折叠和 Edit Diff | `components/ChatWindow.tsx`、`components/MessageView.tsx` |
| 本轮写入文件入口 | `components/TurnWrittenFiles.tsx` |
| 文件树、Git Changes、Source/Preview/Diff | `components/FileExplorer.tsx`、`components/FileViewer.tsx` |
| 右侧文件与终端标签 | `components/TabBar.tsx`、`components/TerminalPanel.tsx` |
| Worktree | `components/SessionSidebar.tsx`、`lib/worktree.ts` |
| Models / Skills / Agents / Plugins | `components/SettingsPanel.tsx` 及对应配置组件 |
| 后台完成提醒 | Browser Notification、Web Push、声音、未读标记 |
| Web/PWA 与移动端 | 响应式抽屉、覆盖面板、移动工具栏 |

### 我们当前更明显的问题

1. **顶部栏过密。** `AppShell.tsx#renderChatToolbarActions` 同时承载历史、自动命名、Subagent、Branch、System Prompt、Tools；旁边还有 Session Stats 和文件面板。
2. **Composer 也过密。** `ChatInput.tsx` 同时放附件、模型、Thinking、Tool preset、Context、Compact、声音；Context 又与顶部 Stats 重复。
3. **搜索碎片化。** 会话、文件、Slash command 各有一套入口和键盘逻辑。
4. **结果仍偏日志。** Process Details 很完整，但用户完成一轮后最关心的“改了哪些文件、变化多大、去哪里审阅”只是一排文件名 chip。
5. **Sidebar 纵向争用。** 项目、Worktree、会话和文件树都放在 260px 左栏；文件树展开后与会话列表平分剩余高度。
6. **空状态缺少任务语义。** 新会话只显示 Pi Web 与版本号，巨大空白没有告诉用户“当前在哪个项目、下一步是什么”。

---

## 三、建议做什么：按收益与侵入性排序

## P0：可以近期做

### 1. 给模型选择器加搜索

**原因：** `ModelSelector.tsx` 已有排序和 Provider 分组，但没有过滤；模型一多，列表会迅速失控。

**做法：** 仅在模型超过一个小阈值时显示搜索框，匹配名称、model id、provider；保留现有分组和键盘选择。

**价值/成本：** 高价值、低成本、零架构变化。

### 2. 收敛顶部栏，而不是再加入口

建议顶部常驻只保留：

- Chat tabs / 当前会话名；
- 运行或未读状态；
- 简化后的 Context/Cost 入口；
- 右侧文件面板开关。

把历史/导出、自动命名、System Prompt、Tools 等低频动作收进一个“会话”菜单。Branch 和 Subagent 仅在确实存在分支/子代理或有活动时露出状态，不要永远占位。

这不是照搬 PI-Desktop 的 Topbar，而是应用它的原则：**状态常驻，操作按需出现，诊断统一收纳。**

### 3. 去掉 Context 的重复表达

目前顶部 Session Stats 与 Composer 都展示 Context。建议：

- 顶部保留轻量百分比和告警色，点击进入完整统计；
- Composer 正常状态不再常驻 Context 数值，只在高水位时显示告警与 Compact 动作；
- Compact 成功提示仍是短暂反馈，不做永久占位。

### 4. 改空状态，但不要做快捷卡片墙

PI-Desktop 曾经加入快捷卡，后来又删掉。我们不应重走一遍。

建议只增加：

- 一句任务导向标题，例如“在 `pi-web-agegr` 中开始一个任务”；
- Composer placeholder 中的一句轻提示：“输入任务；`@` 引用文件，`/` 调用能力”；
- 模型或项目未就绪时只显示对应的阻断提示。

不要加入 mascot、模板宫格、轮播提示或完整 onboarding checklist。

### 5. Sidebar 的会话区与文件区改为可调比例

现有两个区域默认平分剩余高度，容易同时变小。建议加一条轻量拖拽分隔线并记忆比例；双击恢复默认。移动端则优先做“会话 / 文件”二选一切换，不做两个小窗。

这比往 Sidebar 继续塞项目树、通知或插件入口更有价值。

---

## P1：做完 P0 后再考虑

### 6. 把 `TurnWrittenFiles` 升级成“Review card-lite”

我们已经有正确挂点：`components/TurnWrittenFiles.tsx`，也已有 Git Diff 和右侧 FileViewer。无需复制 PI-Desktop 的完整 Review 系统。

第一阶段只做：

- 显示 `3 files · +120 / -18`；
- 文件状态区分新增/修改/删除；
- 点击默认打开右侧 Diff；
- 提供一个“查看全部本轮变更”入口。

明确不做：

- 自动弹开右侧面板；
- 一键 rollback；
- 独立 Review 页面；
- 持久化 patch 快照。

这样用户能一眼判断本轮产物，同时不引入新的版本归属和回滚语义。

### 7. 做一个渐进式 `Cmd/Ctrl+K` 查找入口

目标不是再加一个搜索框，而是逐步替代分散入口。

建议分两期：

- v1：会话全文结果 + 文件名 + 设置页入口；
- v2：再纳入应用命令和最近打开项。

Composer 内的 `/` 与 `@` 应保留，因为它们是“构造 Prompt”的上下文动作，不应被全局搜索取代。全局查找负责导航，Composer 补全负责输入，两者边界要清楚。

### 8. 用少量 UI primitives 统一视觉语法

当前几个大组件大量使用局部 inline style，按钮、Popover、Menu 的圆角、间距、边框、阴影已有漂移风险。不要大改全站，只先抽四个稳定原语：

- `IconButton`
- `AnchoredPopover`
- `MenuRow`
- `StatusPill`

第一批只迁移顶部栏、模型选择器和 Composer 控制。目的不是“组件化洁癖”，而是确保后续做减法时能统一调整密度。

---

## 四、明确不建议照搬

| PI-Desktop 能力 | 不建议原因 |
|---|---|
| Agent / Plan / Goal 三模式 | 会改变 Prompt、状态机、持久化与审批边界；不是 UI 小功能 |
| 每个高权限工具的 Permission Card | 我们当前是 Project Trust + Tool preset；另起权限中间层会造成双重安全模型 |
| 持久通知中心 | 已有未读、浏览器通知、Web Push、声音；成功任务收件箱很容易变成噪音 |
| 插件 Marketplace 和独立 Panel Runtime | 与现有 pi package/extension 体系重叠，宿主隔离成本高 |
| Pull Requests / Scheduled 页面 | 领域扩张，不是核心对话体验优化 |
| Electron 内嵌 Browser/CDP | Web/PWA 宿主条件不同，无法自然迁移 |
| 多项目常驻树和项目资产库 | 当前项目由会话推导，改造会触及持久化和整个 Sidebar 心智模型 |
| 全量 Review + Rollback | 需要可靠快照、并发修改归属和恢复规则；远超轻量 UI 优化 |
| 视觉照抄 | 它的留白、浅灰、圆角和 mascot 服务桌面品牌；我们的高密度工程工作台无需伪装成它 |

也不建议因为 PI-Desktop 移除了内置终端，就直接删除我们的终端。它在我们的浏览器远程工作流里可能有真实价值。正确做法是看使用频率和故障成本，再决定保留、降级为可选入口或移除。

---

## 五、建议的实施顺序

```text
阶段 1：纯 UI 收敛
  模型搜索 → Context 去重 → 顶部低频动作收纳 → 空状态一句话

阶段 2：局部交互改善
  Sidebar 可调比例 → Review card-lite

阶段 3：导航收敛
  Cmd/Ctrl+K 统一导航查找 → 逐步替代独立搜索按钮
```

每一阶段都应遵守两个门槛：

1. **新增一个入口，必须替代或收纳至少一个旧入口；**
2. **不能证明高频使用，就不占常驻 UI。**

---

## 六、最终判断

如果只能选三件事，我会选：

1. **顶部栏与 Composer 去重收敛**——这是当前最真实的复杂度来源；
2. **Review card-lite**——直接提高一轮任务完成后的判断效率；
3. **模型搜索**——最小成本解决已出现的规模问题。

统一搜索有长期价值，但它必须是“替代分散入口”的收敛项目，而不是第四套搜索。其余 PI-Desktop 功能目前都不值得搬。
