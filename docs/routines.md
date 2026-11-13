# Routines（定时任务）

状态：已实现。本文是这个功能的契约：改动与本文冲突时，先改本文。

## 目标与范围

让 Pi Web 按设定的节奏自动给 agent 发 prompt，结果留在会话里供回看。

两种运行目标，数据模型从第一天起都支持：

| 目标 | 每次触发 | 适合 |
|---|---|---|
| **新会话**（`new_session`） | 在指定 cwd 新建一个会话，发送 prompt | 日报、扫描、检查：每次相互独立 |
| **同一个对话**（`same_session`） | 往同一个会话追加 prompt，沿用其上下文（选一个已有会话，或首次运行时新建） | 盯 PR、持续调查、按进度推进 |

分期：

1. **P1（MVP）**：新会话目标、调度器、运行历史、Routines 页面、通知。
2. **P2**：同一个对话目标（已实现）。
3. **P3（可选）**：agent 工具 `create_routine`（聊天里创建，需 UI 确认，已实现）、`routines`（聊天里查看、修改，已实现）；每次运行使用独立 worktree；会话级 `/loop`。

不做：云端运行、事件触发（GitHub/webhook）、自然语言调度表单、Inbox/未读、模板。

## 功能开关

开关只管 agent 的三个定时任务工具（`create_routine`、`routines`、`ask_user`），与子代理、图片生成的开关规则一致：

- 设置 › 常规 › 对话里的"Agent 定时任务工具"是全局默认值（默认开），存在 `routines.json` 顶层的 `toolsDisabled: true`（`RoutineStore.isToolsEnabled()` / `setToolsEnabled()`，`GET/PUT /api/routines/settings`）。
- 项目设置页的同名开关可向两个方向覆盖全局（`projects: { [项目根]: boolean }`，按侧边栏项目根记录，worktree 共用；`RoutineStore.projectState()` / `setProjectEnabled()`，`GET/PUT /api/routines/settings?cwd=`），项目优先；切回与全局相同即去掉覆盖。
- 关闭的项目不注册这三个工具。开关前已启动的会话在重新加载前仍带着它们，所以 `execute()` 再查一次并拒绝。
- 开关不影响调度和入口：底栏 ROUTINES 始终显示，任务是否运行只看它自己的暂停/启用状态。

旧版本的 `featureDisabled: true` 是总开关（隐藏入口、停调度、去工具）。读到它时迁移为 `toolsDisabled: true`，并把非手动的启用任务改为暂停（关闭期间它们本就不跑，迁移后也不能突然开跑）；下次写入时落盘。

## 运行环境与单实例

- 调度器在生产构建（`next start`，即安装版）里默认开启，用户无需任何设置；`next dev` 默认关闭，因为开发中的代码与安装版共用 `~/.pi/agent`。`PI_WEB_SCHEDULER=1` / `0` 可在两边强制开 / 关（`lib/routine-scheduler-flag.ts`）。
- dev（30143）与 stable（30141）共用 `~/.pi/agent`，因此仍需防重复触发：
  - 调度器持有锁 `~/.pi/agent/pi-web/routines-scheduler.lock`（`proper-lockfile`，持有者退出后约 10 秒过期）。拿不到锁的进程每次 tick 重试，不调度。
  - 每次触发先在存储锁内**认领** occurrence：推进 `lastScheduledFor` 并写入 run 记录（`runId = <routineId>:<scheduledFor ISO>`）后才启动，同一 occurrence 只会被认领一次。
- "立即运行"由收到请求的进程执行，不受调度器开关影响（用户显式操作）。
- 只在 Pi Web 进程运行、机器唤醒时触发。

## 存储

单文件 `~/.pi/agent/pi-web/routines.json`（`lib/routines.ts`），写入沿用 `lib/sidebar-state.ts` 的方式（`proper-lockfile` + 原子写，内容未变时不写）。文件损坏时拒绝覆盖。锁的 stale 设为 30 秒：持锁进程被挂起超过这个时间才可能出现重复认领（代码里有 shortcut 注释）。



```ts
interface RoutinesFile {
  version: 1;
  routines: Routine[];
}

interface Routine {
  id: string;                // uuid
  name: string;              // ≤ 80 字
  prompt: string;            // 每次发送的内容，可含 /skill、/prompt 模板
  enabled: boolean;          // 暂停 = false
  schedule: RoutineSchedule;
  target:
    | { kind: "new_session"; cwd: string; toolNames?: string[];
        model?: { provider: string; modelId: string }; thinkingLevel?: ThinkingLevel }
    | { kind: "same_session"; cwd: string; sessionId?: string;   // 无 sessionId = 首次运行新建并回写
        toolNames?: string[]; model?: ...; thinkingLevel?: ... };  // 只在首次新建时使用
  timeoutMinutes: number;    // 默认 30，1–720
  createdAt: string;
  updatedAt: string;
  lastScheduledFor: string;  // 调度器认领过的最新 occurrence；创建/恢复/改调度时设为当前时间
  runs: RoutineRun[];        // 新的在前，最多 50 条（裁剪只丢已结束的，运行中的那条一直保留）
}

type RoutineSchedule =
  | { kind: "manual" }                         // 只能"立即运行"
  | { kind: "once"; at: string }               // 一次性："YYYY-MM-DDTHH:mm"，服务器本地墙上时间；认领后自动暂停
  | { kind: "cron"; exprs: string[];           // 1–8 条 5 段 cron，服务器本地时区；任一条匹配即触发：一个周期内的触发点
      repeat?: { every: number; unit: "minute" | "hour" | "day" | "week" | "month"; anchor: string };
      endsAt?: string }                        // YYYY-MM-DD，含当天
```

- 底层就是 cron，表单只是它的直观写法：手动 / 每小时（第几分钟）/ 每天 / 工作日 / 每周（多选星期）/ 每月（多选几号，含"最后一天" = cron `L`）/ 自定义（每 N 分钟|小时|天|周|月 + 对应的分钟/时间/星期/几号 + 截止日期）/ Cron（直接写表达式，每行一条）。天、周、月可以有多个时间；按分钟分组，每组一条 cron（9:00 和 18:00 → `0 9,18 * * *`，12:30 另起一条）。编译与反解析在 `lib/routine-schedule.ts`（前后端共用）。
- 为什么不是纯 cron：cron 的步长每个周期重新开始（`*/3` 日每月 1 号重来，`*/5` 时每天零点重来），也没有"每 2 周"和截止日期。所以只有整除的步长（分钟整除 60、小时整除 24）写成 `*/N`，其余用 `repeat`：只保留从 `anchor` 起第 0、N、2N… 个周期（周从周一算，月按日历月）。分钟和小时的 anchor 是服务器时区当天零点（小时再加上第几分钟；不能用"上一个 `M 0 * * *`"，零点到 M 分之间创建会取到昨天、整个相位错开）（每 45 分钟 = 00:00、00:45…，跨天不重来）；天、周、月的 anchor 是创建后第一个触发点，所以下一个匹配的时间点一定会运行。编辑时保留原 anchor，换单位时清空；已有 anchor 的分钟/小时节奏即使步长能整除也保留 `repeat`，不改写成 `*/N`（API 写入的相位不能被挪到零点）。没有 31 号的月份没有触发点，但仍计入月数。
- 分钟级 `repeat` 只允许配 `["* * * * *"]`，按 anchor 直接算时间，不逐分钟扫描。
- 切到 Cron 时，文本框预填表单当前编译出的表达式（自定义的"每 N"不在文本里，会丢掉）；从 Cron 切回表单时，表单能表达的表达式会被读回来。API 写入的、表单表达不了却带 `repeat` 的 cron 在 Cron 模式下原样保留 `repeat`。
- `toolNames` 缺省 = 跟随 `defaultTools`（与新建会话的默认一致）；`[]` = Chat only；其余同工具预设。界面只认与预设完全相同的列表，其他列表显示为自定义并原样保存，绝不就近归入某个预设（否则可能给无人值守运行加上 bash/write）。
- `model` / `thinkingLevel` 缺省 = 跟随设置里的默认值。
- 时区：服务器本地时区（与 Claude Desktop、ZCode 一致）。不存时区字段；`GET /api/routines` 返回服务器时区，界面的触发预览和时间都按它显示（浏览器可能在别的时区）。

```ts
interface RoutineRun {
  runId: string;             // <routineId>:<scheduledFor>，手动为 <routineId>:manual:<uuid>
  routineId: string;
  trigger: "schedule" | "catch_up" | "manual";
  scheduledFor: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  status: "running" | "succeeded" | "failed" | "aborted" | "timed_out" | "skipped";
  skipReason?: "previous_running" | "concurrency_limit" | "target_busy";
  pid?: number;              // running 时的所属进程；进程已不在 → 读作 failed（Interrupted）
  sessionId?: string;        // 跳转用
  error?: string;
}
```

## 调度规则

- 每 30 秒 tick 一次；cron 解析与下次时间计算用 `croner`（零依赖，处理 DST）。
- **错过的运行**（服务停机、休眠）：启动或 tick 时，若最近 7 天内有错过的 occurrence，只补跑**最近的一次**（`trigger: "catch_up"`），更早的丢弃。prompt 应自带时间护栏。
- **重叠**：同一 routine 上一次仍在运行 → 记录 `skipped/previous_running`，不排队。
- **并发上限**：全局同时运行的定时 run（不含"立即运行"）不超过 2 个；超出记 `skipped/concurrency_limit`。
- **最小间隔**：相邻两次触发间隔，新会话目标 ≥ 15 分钟（每次一个新会话，避免刷屏和反复冷启动），同一个对话 ≥ 5 分钟（`minIntervalMs()`，前后端共用）。
- 应用升级中：`startRpcSession` 抛错，run 记 `failed`。
- "立即运行"不计入并发上限，但上一次仍在运行时返回 409。
- 暂停期间不触发，恢复后从下一个 occurrence 开始，不补跑。

## 执行：新会话目标（P1）

实现：`lib/routine-runner.ts`。

1. `startRpcSession(tempKey, "", cwd, { toolNames, initialModel, thinkingLevel, persistStartupPreferences: false })`，与 `app/api/agent/new/route.ts` 同路径。cwd 不存在 → `failed`。项目信任沿用 `startRpcSession` 的现有门控。
2. 写会话名 `<routine 名> · <本地日期时间>`（`set_session_name`）。
3. 追加自定义 entry `pi-web:routine-run`（`{ routineId, runId, mode, name }`，经 `AgentSessionWrapper.markRoutineRun()`），侧边栏据此标记来源，聊天据此把 prompt 显示为运行行（见 UI 的来源标记）。
4. `send({ type: "prompt", message })`；收到 `prompt_done`/`agent_settled` 且会话不再运行时结束（重试、压缩、排队消息会越过第一个终止事件）。结果：被中止 → `aborted`；`prompt_error` 或最后一条 assistant `stopReason: "error"` → `failed`；否则 `succeeded`。
5. 超过 `timeoutMinutes` → `send({ type: "abort" })`，记 `timed_out`。期限从发送 prompt 前开始计，也覆盖停在扩展对话框上的 slash 命令；abort 本身最多再等 30 秒。超时即释放并发名额，即使会话还在收尾。
6. 成功：沿用现有 `onAgentRunComplete → notifySessionComplete`（会话完成推送）。失败、超时、跳过、自动暂停、开始补跑见下方"通知"。
7. **独立 worktree**（`target.worktree`，仅新会话目标，默认关）：每次运行用子代理 `isolation: worktree` 同一套临时检出（`lib/subagent-worktree.ts`：tmpdir 里从项目当前 HEAD detached 检出，不带未提交改动）。运行结束：没有改动和新提交 → 删除检出；有改动 → 提交（`routine: <名称>`）到 `routine/<id 前 8 位>-<YYYYMMDD-HHmm>` 分支并删除检出，分支名记在 run 的 `branch` 上，历史里显示。提交失败（例如没配 git 身份）时检出保留，run 记 `failed`，错误里写明检出路径。检出删除后，这次运行的会话 cwd 已不存在，只能查看；要继续改动请在主项目检出该分支。与子代理隔离相同的限制：未跟踪的项目 `.pi/settings.json` 和项目信任不带进临时检出。项目不是 git 仓库时，运行失败并写明原因。

**陷阱**：显式 model/thinking 默认会被 `lib/startup-preferences.ts` 写回全局默认。routine 运行传 `persistStartupPreferences: false`，否则每次运行都会改用户的默认模型。

### 无人值守时的扩展对话框

pi 内置工具没有权限确认；对话框只来自扩展主动调用 `ctx.ui.select/confirm/input/editor`（权限闸门类扩展、向用户提问的工具、不带参数的交互式 slash 命令）。当前配置的扩展只在 `/web`、`/x-search` 命令无参数时弹选择框，agent 运行中不会出现。

Pi Web 中这类对话框会挂起并重放给打开该会话的页面。P1 不做专门处理：用户可以进会话回答，否则由超时中止。若以后装了会在运行中提问的扩展，再加"需要处理"推送。

## 执行：同一个对话目标（P2）

实现：`lib/routine-runner.ts` 的 `openRunChat()`。

- 还没有 `sessionId`：与新会话目标一样新建，会话名就是 routine 名（不带时间），然后 `bindSession()` 回写 id（同时更新 `updatedAt`，干净的表单随之显示该对话）。之后每次都继续它。
- 有 `sessionId`：使用会话自己的模型、思考级别和工具集；routine 不覆盖（表单里隐藏这些控件，显示"沿用这个对话的模型和工具"）。
- 会话正在运行（用户在用）或文件正被修改（`isRpcSessionFileMutationReserved`）→ 每 5 秒检查一次，等到空闲；等到下一个 occurrence（手动运行则到超时）仍忙 → 记 `skipped/target_busy`。等待期间 run 仍是 running、占并发名额。不用 steer/followUp 插入用户正在进行的回合。
- 目标会话被删除 → run 记 `failed`，routine 自动暂停（`pause()`），错误写明原因。fork 不影响：仍绑定原会话 id。
- 创建/保存时 `sessionId` 必须能解析到会话文件，否则 400（`app/api/routines/target.ts`）。
- 绑定后不会被解绑：保存时请求里没有 `sessionId`，服务端在存储锁内沿用已绑定的 id（首次运行恰好在表单加载后绑定也不丢）；选另一个对话会替换，切回"每次新开对话"会去掉。所以已绑定的任务，"对话"下拉里不再有"首次运行时新建"。
- 上下文增长交给 pi 的自动压缩；prompt 应写成可重复执行的形式。
- 每次运行前追加 `pi-web:routine-run` 标记。

## 在聊天里创建、查看和修改（`create_routine` / `routines`）

实现：`lib/routine-tool-extension.ts`，挂在 `startRpcSession()` 的宿主扩展列表里（Chat only 与子代理没有）。

- **定位**：参照 Grok 的定时任务，agent 不是把用户原话抄成任务，而是先弄懂、先做一遍、再定下来，之后还能自己调：
  1. 弄清目标；会改变结果的选择（来源、范围、筛选、频率、输出）自己定不了就问（`ask_user`，见下节）。
  2. 在当前对话里用正式运行的同一套方法（同样的工具、页面、访问方式）试跑一轮，结束本轮把结果给用户看；访问受阻当场暴露，不留到第一次定时运行。纯提醒类可跳过。
  3. 用户认可后创建，指令里写进验证过的做法：去哪看、用什么工具、筛选、输出格式、如何避免重复上次、受阻时报告什么。
  4. 之后用户说要调整，或某次运行暴露出指令/计划有问题，直接用 `routines` 改，不另建一个再让用户停旧的。
  这套流程写在 `create_routine` 的工具描述里（只是提示，模型仍可能跳过试跑；不做强制拦截，免得简单提醒也变重）。
- **普通宿主工具**（与 `generate_image` 同一模式）：开关打开就注册、直接声明给模型，关掉就不注册；不用 `deferred`，不激活 `tool_search`，不加提示行。三个工具都是 `exposure: "model-only"`：要等用户批准或要结束本轮，codemode 脚本里调用会占住 worker 或让卡片和 `terminate` 失效。以前是 `deferred` + 每个会话强制激活 `tool_search`：在只有 codemode MCP 服务器的项目里，pi CLI 不开 `tool_search`，Pi Web 却开了，模型（实测 grok）就用它把 codemode 服务器的工具直接加载出来。现在发现工具开不开完全按用户的 pi 配置。旧会话例外：会话记录里已声明的 `tool_search` 和它加载过的工具会照常恢复，不自动清理（分不清来自旧 routines、用户选择还是 deferred MCP）。同理，项目关掉工具期间继续过的对话，记录里写着这三个工具被移除，重新打开后要在该对话里 Reload 才回来（与生图开关相同）。常驻开销是三个定义，旧 `deferred` 时期实测 `create_routine` 466、`ask_user` 195，合并后的 `routines` 未实测（原 `update_routine` 274 + `list_routines` 106）；不想要的项目用项目开关关掉。描述只写模型从参数名和校验错误推不出来的东西；长度、条数、最小间隔、cron 步长这些限制只在服务端校验（错误连同服务器时间返回给模型），不写进 JSON schema。"试跑后结束本轮、给用户看结果、同意后再建"必须写成明确的步骤：写成"试跑并展示结果"时，模型会试跑完直接创建，结果在批准之后才给。描述是静态文本，不含当前时间，不破坏提示缓存。
- **参数**（刻意比表单少，介于 Claude 的"只有 cron、只能新会话"和完整表单之间）：`name`、`instructions`、`run_in`（`new_chat` / `this_chat`）、`cron`（一条）或 `at`（一次）。一天多个不同分钟的时间、每 N 周、截止日期这类少见形状，创建后在 Routines 页面改。项目固定为当前对话的 cwd。`new_chat` 复制当前对话的模型、思考级别和工具选择（`readSessionToolSelection`，缺省即跟随 `defaultTools`），所以不会比当前对话权限更大；`this_chat` 绑定当前对话 id（首轮会话文件可能还没落盘，所以不像表单那样校验文件存在）。
- **校验**与表单保存一致（`parseRoutineInput`：最小间隔、never runs 等），错误作为工具结果返回，附服务器当前时间，模型据此修正。用户确认后按当时时间再校验一次：确认期间已过期的一次性任务不创建。
- **确认**：`ctx.ui.confirm` 额外带 `piWebCard`（结构化的 `RoutineApprovalCard`：名称、计划、服务器时区、下次运行、运行方式、指令、调度是否开启），`rpc-manager` 原样放进 confirm 请求的 `card`。Pi Web 据此在聊天末尾、工具调用下方内联渲染 `RoutineApprovalCard`（不是居中弹窗，也没有"extension request · 倒计时"字样）。与输入框同一层次：只有一条外边框，没有标题条、分隔线或内部灰框。依次是小字说明"定时任务 · 待确认"、任务名、一行事实（计划用 `describeSchedule` 的人话 · 下次运行按服务器时区并带相对时间 · 运行方式）、指令作为引用段落（左侧细线，次级文字色，超过约 6 行淡出并给"展开全部"），右下"取消 / 创建任务"，Esc 取消。按浏览器语言显示。Markdown 的 title/message 只给其他扩展 UI 客户端兜底。15 分钟无人回答或被中止 = 未创建；无人值守的 routine 运行里调用它同样会超时放弃。
- **创建之后**：卡片消失，工具调用和其他步骤一起收进本轮的过程组；不另起结果卡片（与 Claude 一样克制）。本轮回答下方多一个小标签（与"写入的文件"同款，`TurnArtifactChip`，`components/TurnArtifacts.tsx`）：时钟图标 + 任务名，点击打开 Routines 页面的该任务（`lib/routine-events.ts` 的 `pi-web:open-routine` 事件 → AppShell 切到 routines 视图并传 `openRequest`；表单有未保存修改时先确认）。标签来自本轮 `create_routine` 结果的 `details.created/routineId`（`lib/turn-routines.ts`），被拒绝的不显示。
- 结果文本：创建成功一句话（名称、下一次运行）；失败或被拒绝时附服务器当前时间，供模型改正。调度器关闭时额外说明只能"立即运行"。
- **范围**：`routines` 看得到、改得了当前对话所在项目的全部任务（按 `resolveProject()` 的项目根比较，worktree 算同一项目），其他项目的任务当作不存在。
- **`routines` 不带要改的字段 = 查看**（只读；空字符串算没给）：每个任务一行：id、名称、开/停、计划人话、下次运行、在哪运行（每次新开 / 本对话 / 某对话）、上次运行。带 `id` 时再给完整指令和最近 10 次运行（应触发时间、实际开始时间、状态、跳过原因、错误、会话 id），用来回答"为什么没按时发""上次为什么失败"。
- **`routines` 带 `id` 和要改的字段 = 修改**（以前的 `update_routine`，旧对话里的调用照样出小标签）：只改名称、指令（整段替换）、计划（一条 cron 或一次 `at`，会替换原计划，包括表单才有的多时间、每 N 周、截止日期）和启用/暂停；项目、绑定的对话、模型、工具只在 Routines 页面改，所以聊天里的修改不会扩大运行权限。校验与表单保存相同（`parseRoutineInput`），在存储锁内基于最新定义合并（`RoutineStore.update` 接受函数）。**不弹确认**，与 Grok 一致：改动立即生效，结果文本列出改了什么（"schedule: Every hour → Every day at 09:00 AM"），由 agent 告诉用户；本轮回答下方出现"已更新 · 任务名"小标签，点开就是任务页，改动是白箱的。只读工具预设的对话拒绝修改（无人值守的运行不能在没有写权限、也没有确认的对话里被改写）。删除仍只在 Routines 页面，需要停掉就暂停。
- **风险**：不确认意味着被提示注入的内容（例如运行时读到的网页）也可能让 agent 改写任务。有写权限的对话本来就能用 bash 改任何文件，所以这不是新的边界；只读对话被挡住。

## 向用户提问（`ask_user`）

实现：`lib/ask-user-extension.ts`（由 routines 扩展注册，随定时任务开关），界面 `components/QuestionCard.tsx`，纯函数 `lib/ask-user-answer.ts`。参照 Grok 的选项卡片。

- **只属于定时任务**：随 routines 工具一起注册，描述以"While setting up a routine"开头，`create_routine` 的描述里也指向它（"定不了就用 ask_user 问"）。想把它变成通用工具，改描述即可，界面无需改动。
- 参数：`question`、2–6 个单行短 `options`、`multi_select`。选项不能以 `!` 或 `/` 开头：点卡片走的是输入框的发送路径，`!` 会直接执行 shell 命令、`/` 会执行斜杠命令（模型生成的文字不能变成用户命令，网页里的提示注入也可能让模型写出这种选项）。应当单独调用：`terminate` 只有整批工具都要求时才生效，和别的工具同批时本轮会继续，只能靠结果文字让模型停下。不设单独的说明字段：背景写在调用前的回答文字里（卡片紧跟其后），否则模型会把同一句话写两遍。长度限制只在 `parseAskUserParams` 里校验，不写进 JSON schema（schema 每次请求都要带）。
- **不阻塞**：调用立即返回并带 `terminate: true`，本轮就此结束；答案作为用户的下一条普通消息到来（点卡片发送选中的选项，每行一个；或在输入框里随便打字）。所以没有等待中的扩展对话框：无人值守的运行、关掉的页面、10 分钟空闲回收都不会卡住。
- 显示：`ask_user` 调用算作回答的一部分（`lib/message-display.ts`），不收进过程组。卡片：问题、带字母的选项，不加固定提示文字。最新且未回答、会话空闲、没有正在编辑的历史消息时可点（编辑中发送会进那条编辑）：单选点一下即发送；多选勾选后点卡片右下的"发送"。已回答时只留选中的选项（答案的某一行与选项文字相同）；用户自己打字回答时全部选项变灰。
- **点卡片发出的答案不显示气泡**（与 Grok 一致）：只有当问题调用成功（失败的调用显示为普通错误块，没有卡片替它显示答案）、这条用户消息是问题之后的第一条、纯文本、且正好等于所选选项逐行排列时才隐藏（`findAskUserAnswers().cardAnswerIndexes`）；自己打字的回答照常显示。会话文件里它仍是普通用户消息，模型收到的就是这些选项文字。

## 通知

实现：`lib/routine-notify.ts`，走现有推送（`lib/web-push.ts` 的通用 `notify`，按订阅者语言出文案）。每个任务一个 `tag`（`pi-routine:<id>`），反复跳过的任务只替换同一条通知，不堆叠。

| 事件 | 时机 | 点击打开 |
|---|---|---|
| 失败、超时 | 运行记录写完后 | 有会话 → 那次运行的会话；否则任务概览。有会话的失败沿用会话完成推送的 tag（`pi-session-complete:<会话>`），替换掉它而不是多一条 |
| 跳过（上次未完成、并发已满、对话正忙） | 认领时 / 等待对话超时后 | 任务概览 |
| 自动暂停（继续的对话被删） | 运行失败时 | 任务概览 |
| 开始补跑 | 调度器启动补跑时（同 Claude） | 任务概览 |

成功不另发（会话完成推送已覆盖）；手动中止不发。`claimDueRuns` 返回 `{ started, skipped }`，跳过的由调度器发通知。

## API

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/api/routines` | 列表（含 `runs`）+ 每个 routine 的 `nextRunAt`，以及 `schedulerEnabled` |
| POST | `/api/routines` | 创建（校验 cron、最小间隔、cwd 或要继续的会话存在） |
| PATCH | `/api/routines/[id]` | 整体替换可编辑字段；`enabled` 切换即暂停/恢复（列表和概览的开关原样发回存储的定义，不经表单往返）。只校验新选的对话是否存在：项目或对话已被删除的任务仍能暂停、改名 |
| DELETE | `/api/routines/[id]` | 删除定义；已产生的会话保留 |
| POST | `/api/routines/[id]/run` | 立即运行（202）；上一次仍在运行返回 409 |

`cwd` 创建后不可修改（与 ZCode 一致，避免历史和会话分组错位）。

## UI

定位：routine 是 agent 按计划开始的对话，是和聊天平级的工作对象，不是设置项（参照 ZCode Automations）。

实现：`components/RoutinesView.tsx`（样式 `app/routines.css`），日程预设与 cron 互转在 `lib/routine-schedule.ts`。

- 主区域视图：`AppShell` 的 `mainView: "chat" | "routines"`。打开后覆盖在聊天窗格上方（聊天保持挂载，流不中断，窗格 `inert`）；首次打开后 RoutinesView 也一直挂载，回到聊天再回来，未保存的表单仍在。只在显示时轮询（5 秒）。
- 入口：侧边栏底栏右端的 "ROUTINES"（"SETTINGS" 在左端；ROUTINES 右对齐，文字右缘与上方 PROJECTS/EXPLORER 栏最后一个图标的右缘对齐；再次点击回到聊天）。工作区顶栏在侧边栏按钮旁有返回箭头（`routines.backToChat`），列表页和任务页都能直接回到聊天。选择会话、切换/新建聊天标签、新建会话也会回到聊天。
- 顶栏：侧边栏按钮之后是返回箭头，然后任务页（概览、编辑、新建）显示面包屑（`Routines › 任务名`），由 RoutinesView 通过 portal 放进工作区顶栏，替代聊天标签和聊天工具按钮；列表页这块留空，页面自己的标题已经是 "Routines"。
- 首页：只有标题（参照 Claude，不加说明），有任务时右上角"新建"（深色主按钮）。这些页面上的文字按钮（新建、空状态的新建、表单的取消/保存、立即运行）一律是全站 26px 的控件（`--ui-row-height`，`.routines-button` 字号 13px）：页面空不是把按钮做大的理由。行高和控件高度是同一个值；调度器关闭时的提示条；无任务时居中的空状态：只有秒表插画和"新建"，不加说明文字和卡片框（"还没有定时任务"只作为无障碍名称）。插画是 Claude 的手绘秒表，从其截图用 potrace 矢量化而来（不是重画，手绘的轮廓和指针原样保留）：线条一条路径（`currentColor`），表盘填充一条路径（文字色 9%，与 Claude 灰盘对白底的对比相当），表冠和颈部内部不填、露出页面底色；84×96，高约为按钮的 3.4 倍，与按钮相距 24px；任务卡片（名称、计划摘要、下次运行、上次结果、启用开关）。
- 新建：直接进表单。字段顺序参照 Claude Desktop：名称；指令；运行方式；计划；超时。底部"取消 / 创建"。
- 已有任务先看**概览**（`components/RoutineOverview.tsx`，参照 Claude 的查看页）：页面开头一行是任务名（16px 600，可换行）和它的操作——编辑（铅笔）、删除（垃圾桶，确认后删除）、"▶ 立即运行"，和列表页的标题与"新建"同一结构，排在页面宽度之内。不放进工作区顶栏：那样按钮落在整条顶栏的最右端，桌面上和页面内容隔得很远，手机上又读作全局/状态区域，不像这个页面的操作。"立即运行"是细边框的次要按钮（`ConfigButton` secondary/small），与旁边的图标按钮同为 `--ui-row-height`（26px）：手动运行是偶尔的操作，不该是页面上最重的元素。图标间距 4px，与按钮隔 6px。左栏只有三项，上标签（12px，`--text-muted`）下值（14px）：状态（开关 + 状态小签：已启用/已暂停/运行中）、计划（人话 + 下次运行）、"运行设置"——一排可换行的小签（运行方式或绑定的对话〔可点〕、项目、模型 · 思考级别、工具、最长时长），不再一项一行往下堆；"在同一对话里继续"且已绑定时不显示模型和工具（沿用该对话）。右栏：指令按正文字号直接显示（超过约 220px 淡出并可展开），运行历史是页面上的白色行，行高为全站统一的 `--ui-row-height`（26px，行距 2px）（状态图标 + 计划时间 + 右侧备注，失败/超时/中止为红色；有会话的整行可点，悬停出现边框）。窄屏单栏。
- **宽度**：列表和概览页最宽 `max(960px, 会话宽度 + 64px)`（双栏需要比聊天单栏更宽，会话调宽时跟着变宽）；编辑/新建表单等于会话宽度 `--chat-content-max-width`（指令框就是聊天输入框，两边对齐）。概览左右栏 `minmax(200px, 280px)` 对 `1fr`、间距 56px，960 宽时约 1:2；窄于 760px 单栏。
- **手机**（≤640px，与 `hooks/useIsMobile.ts` 相同）：列表头部改为上下排列；卡片里的状态与上次结果上下叠放；概览的任务名换行显示全名，操作排到名字下方、左对齐，"立即运行"在最前；历史的备注换到时间下方而不是截断；表单里的聊天输入框去掉手机端自带的左右内边距，与其他字段对齐；计划的 9 个预设在手机上排成 3 × 3 等宽格；中间宽度（平板、窄窗口）放不下一行时在轨道内换行，并且每行的按钮撑满轨道，不留参差的空隙（"运行方式"同理）；长任务名在手机上换行而不截断，面包屑里的"定时任务"不折行；确认卡片的要点一行一条。菜单行在手机上也是 26px（全站统一，见 docs/ui.md）。
- 点铅笔进入编辑（同一套表单，标题"编辑「名称」"），底部"取消 / 保存"；取消（有修改先确认）或保存后回到概览。删除只在概览里。
- **列表**：两列卡片网格（窄屏一列），每张是任务名（14px 600）、计划的人话（同一对话时带"同一对话"小签）、一行状态（运行中 / 已暂停 / 下次… · 上次结果，失败为红色）；右上只有启用开关：手动运行是偶尔的操作（经常要手动跑就不算定时任务），放在任务页里，列表不给它快捷入口（与 Claude 一致）。卡片悬停时边框加深、带一层浅阴影。调度关闭的提示是带信息图标的细边框横幅。不再有"全部任务 · N"行。
- 运行方式（指令框下方）：分段按钮"每次新开对话 / 同一个对话里继续"，下面一行说明两者区别。选后者时旁边出现"对话"下拉：首次运行时新建，或该项目最近 50 个会话（侧边栏会话列表，不含子代理）。换项目会清空所选对话。列表卡片的摘要里标"同一对话"。Git 项目选"每次新开对话"时，说明下方多一行"每次运行用独立 worktree"：用应用自己样式的 13px 复选框（与侧边栏多选同款 `.sidebar-session-checkbox`），不用浏览器原生样式，也不用 36px 的开关（挂在两行文字旁显得突兀）；复选框居中对齐文字第一行，点文字也能切换，下面是一行说明。
- 计划（`RoutineSchedulePicker`）参照 Claude Desktop：频率是一排分段按钮（手动 / 一次 / 每小时 / 每天 / 工作日 / 每周 / 每月 / 自定义 / Cron），下面一行"标签 + 控件"：`时间 [上午 09:00] × [下午 06:00] × +  星期 [周一、周五]`；自定义在同一行加 `每 [N] [单位]` 和 `结束 [永不/指定日期]`（不用弹窗）；Cron 参照 Claude：带"Cron 表达式"标签的整行输入框（白底细边框、等宽字体，一行一条，回车加行时自动增高），下面一行格式说明，再下面截止日期。时间用自绘的上午/下午、时（12 小时制，01–12）、分三列菜单（`TimePicker`，与其它菜单同一 `.menu-surface`；上午/下午的文字和前后位置取自 locale），不用浏览器原生时间控件；页面上的时间都按 12 小时制显示。下拉菜单（`Select`，单选多选都一样）只用勾表示选中，只有鼠标/键盘所在的一行有底色；选中行也铺底色时，相邻几行会成一块块分开的灰底。单位菜单固定用复数（minutes/hours…），按钮上的文字随数量变（1 hour / 2 hours）。预览只在计划改变时重算；最小间隔检查在浏览器本地时区算（croner 带时区每个触发点约 0.4 ms，逐次点选会卡），以服务端校验为准。截止日期手输 YYYY-MM-DD。下方一行按服务器时区预览接下来 3 次，或说明为何不能保存（没选星期/日期、日期格式不对、cron 写错、间隔小于最小间隔、之后不再运行）。
- 指令框就是聊天输入框（复用 `.chat-input-composer` 与 `.chat-input-dock`），只是更宽、静止时约 6 行高，随内容自动增高（上限 50vh 后滚动），不可拖动。工具栏与输入框一致：左边模型、思考级别，右边项目、工具预设（跟随默认 `configured` 时只显示图标，其它预设才显示名称）。项目用新对话的同一个选择器（`NewSessionCwdControl`：项目名列表、worktree 分支、Custom path…，经 `/api/cwd/validate` 校验），菜单向上弹出；创建后只读，显示项目名；标签不带下拉箭头。
- 模型与思考级别总是显示具体值，不显示"default"：新任务按当前默认模型和该模型的默认思考级别填好并随任务保存（与新建对话一致）；换模型时思考级别按新模型支持的档位收敛。旧任务若没存模型，显示默认值但不改写。
- 文案从简：说明文字一句话说清一件事，不重复标签或控件已经表达的内容（新建表单没有副标题；运行方式、worktree 的说明各一句）；提示（title）不加句号。
- 页面内主按钮固定用中性色（`--control-on`），不跟随 Paper 配色的橙色强调色；运行中状态也不用强调色。
- 历史：一个列表卡片，有会话的行点击后切回聊天并打开那次运行的会话。
- 返回列表时若有未保存修改，用 `useConfirm()` 确认；表单干净时跟随服务端的更新，有未保存修改时不被覆盖。
- 来源标记（两种目标都有）：每次运行在 prompt 前追加 `pi-web:routine-run` 自定义 entry（`lib/routine-run-entry.ts`，无依赖）。运行结束时标记后面若没有任何 user 消息（prompt 被拒，比如登录过期；或命令没发消息），追加 `pi-web:routine-run-end`（`AgentSessionWrapper.endRoutineRun()`）：聊天历史和侧边栏遇到它就作废标记，之后有人在这个对话里打的字不会被当成这次运行的 prompt。
  - 侧边栏：会话列表扫描（`lib/session-list-scanner.ts` 的 `foldLine` → `foldRoutineMarks`，`lib/routine-run-entry.ts`；运行中的会话由 `getRpcSessionInfos` 用同一规则）给 `SessionInfo.routineId`，行尾显示时钟图标。扫描索引格式升到 6（旧索引重建一次）。
  - **运行会话不进侧边栏**（参照 Claude：运行会话从任务的历史进入，侧边栏顶多每任务一行）：标记里带 `mode`（目标类型）。新会话目标的运行会话、且没有人在里面写过一条非 routine 的消息 → `routineRunOnly`，侧边栏的项目列表、最近项目、首次自动选中项目都不算它们（`SessionSidebar` 的 `listedSessions`）。入口：任务历史、聊天里的小标签、通知。你在里面回复过 → 成为普通对话，回到侧边栏。fork（头部带 `parentSession`）复制了标记，但是你自己的对话，总是列出。"同一个对话"绑定的对话照常显示。"对话"下拉也不列 `routineRunOnly` 的会话。
  - 删除任务时，它的 `routineRunOnly` 会话被归档（`DELETE /api/routines/[id]` → `updateSidebarState(..., { archived: true })`），在侧边栏归档里能找到，不删除。
  - 聊天：routine 发出的 prompt 对模型仍是一条普通 user 消息，但界面不画用户气泡（用户关心的是"这时跑了哪个任务"，不是每次重复的同一段指令；同 `ask_user` 卡片答案不显示气泡）。改为居中的一行（`RoutineRunView`，`components/MessageView.tsx`，共用 `TranscriptMarker` 与样式 `.chat-marker*`（压缩、缓存续期同款，见 docs/ui.md），参照 Grok）：时钟图标 + 任务名 · 发送时间，后面一个小箭头，不加其他说明文字。点任务名/时间进入 Routines 里该任务（`pi-web:open-routine`，与创建后的小标签同一路径）；点箭头在下方展开这次实际发送的指令（任务页显示的是当前指令，改过任务后两者不同）；会话搜索命中这条消息时自动展开。没有编辑、fork、复制。名字依次取：任务当前的名字（`routineNameLookup()`，会话接口读一次 `routines.json`）→ 运行时写进标记的名字（任务已删除）→ "定时任务"。
  - 历史：`buildSessionContext` 把标记后面那条 user 消息复制一份并带上 `routineRun`（不改会话里的原对象）；中间先出现别的消息（运行的是不产生 user 消息的命令）就不再标记；分页从这条 prompt 开始时往前找它的标记。实时：SSE 没有自定义 entry 事件，所以 `markRoutineRun()` 同时记下待标记的运行，wrapper 把紧接着的 user `message_start/end` 事件复制一份带上同一个 `routineRun`（`prompt_done`/`prompt_error` 先到则作废），实时运行时也不会先闪出气泡（`lib/rpc-manager-queue.test.mjs`）。
- 一次性（`once`）：分段按钮"一次"，填日期（YYYY-MM-DD）和时间。按服务器时区的墙上时间算（夏令时跳过的时间在跳过后立即运行）。认领时（运行或跳过）自动暂停；暂停的任务允许保留已过期的计划，所以仍能改名、删除；重新启用必须先改到未来时间（"之后不会再运行"）。错过时与其他计划一样，7 天内补跑。
- **地址栏**：`?routines`（列表）/ `?routines=<id>`（某个任务）。刷新、通知点击、直接打开都回到对应页面（`lib/initial-navigation.ts`）；RoutinesView 换页时经 `onPageChange` 改地址；从底栏回到聊天时地址恢复为当前会话的 `?session=`。
- "对话"下拉按项目筛选会话时用浏览器端的 `sameCwd()`（Windows 路径忽略大小写和分隔符），不用 `===`。
- 不做：模板；运行中扩展对话框的专门处理（遇到再说）。

## 开发环境

- dev 默认不调度：`PI_WEB_SCHEDULER=1 npm run dev` 才会按计划触发；不带它时只测界面和"立即运行"。
- 测试运行会在真实的 `~/.pi/agent` 里生成会话；用一个临时目录做 cwd。
- 调度器在进程启动时起一次（`globalThis` 守卫），热更新不会替换它的闭包：改了调度/存储代码后要重启 dev，否则定时触发还跑旧代码（"立即运行"走新代码，两者会不一致）。
- `claimDueRuns` 按任务单独捕获异常：一个算不出计划的任务只记日志并跳过，不影响其他任务触发。
