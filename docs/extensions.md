# Web 扩展兼容

## 扩展主动结束

`ctx.shutdown()` 记录退出请求，等待绑定、当前 prompt、手动 compaction、Bash 和正在执行的变更完成；等待期间仍接受 Stop、steer 和 follow-up，不预先关闭 admission。空闲后使用现有五秒 `session_shutdown` 清理期限，最终 dispose/unregister，然后通过 SSE 发 `session_ended`，最后关闭流。已经在 `session_start` 中结束的冷启动 wrapper 也回放终止事件；清理期间新订阅不会被当作 idle 回收重连。

结束只影响当前视图的连接实例：它停止主动/被动重连，保留 transcript、标签位置、分屏和草稿，以现有通知栏持续提示只读状态，禁用 composer。用户关闭再打开标签或刷新页面得到新的连接，可以正常恢复同一个 session id；没有进程级永久禁止重开列表。与上游自动关闭标签不同，稳定标签组件是本项目保留草稿、滚动位置和 split pane 的边界，因此不强制切走。

结束视图的整个 composer 控件区（含模型、thinking、tools、compact）禁用，分支面板保留行但不提供导航操作。hook 和窗格顶栏的公共 agent 命令入口按视图状态拒绝全部 RPC（包括可能隐式启动 runtime 的查询），以挡住旧回调或已经打开的菜单；模型、thinking、tools 的乐观偏好更新也在结束后跳过。这个限制不在服务端保存，关闭重开不受影响。

收到 `session_ended` 后废弃旧 HTTP 响应和待调度的空闲刷新，再通过只读 `/api/sessions/[id]` 做一次最终历史同步；该 GET 读取 SessionManager/文件，不创建 AgentSession，也不重连 SSE。它使用最后已加载 entry 作为 anchor，保留分页并补齐紧接退出的 custom 消息和 `session_shutdown` hook 最后保存的内容。退出后仍可读取历史；404 不清空现有 transcript（包括手动重试），晚到的导航结果也不能覆盖最终快照。

清理后丢弃路径、只读解析和列表缓存。start、工具设置和重命名在等待旧 wrapper dispose 后重新检查文件存在，返回 404 而非让 SDK 在旧路径创建新会话。收到退出请求的 Bash/扩展命令也不再把未保存或被删除的文件通过 command-only fallback 写回。旧 SDK hook 本身若超时后继续执行，其外部副作用不可能由宿主撤销。

## 空闲 custom 消息

仅可见 custom 的空闲 `message_end` 请求历史刷新（隐藏判定复用 `message-display.ts`），不直接把 SSE 对象塞进 transcript；SDK 已先保存消息，因此 HTTP 快照提供真实 entry id、leaf 和树。同步连发共用一次读取，读取期间的后续通知只追加一次读取。通知递增既有 local-append fence，旧 HTTP 响应不能覆盖它；空闲读取跨运行、分支、会话切换或卸载时丢弃。Bash 和导航期间推迟刷新，完成后再读，避免 pending command 与已保存记录双显。

与上游的 tail/cache 增量方案不同，本项目复用 `/sessions/[id]` 和 `mergeLoadedHistory`，同步刷新 leaf/tree，Clone 无需另存 leaf。空闲请求带最后已加载 entry 的 `anchor`，服务端仅在它属于当前分支时扩展尾窗以保证重叠：超长连发也不丢间隙，合并保留已经向上翻出的分页。普通刷新和分页行为不变。

## 启动和重载诊断

SDK service diagnostics、loader errors/warnings 和绑定时 `session_start` 错误写完整服务端日志，通过现有 notify / extension_error 通道显示。诊断复用通知缓冲，最多保留七条明细加一条省略提示；普通扩展通知保留最近十条、两分钟。缓冲不被第一个订阅者消费，后续页面和 split pane 都能收到相同 id；每个 hook 自己记住最近 200 个通知 id，重连不重复弹出，也不会让另一个窗格漏看。

`/reload` 和 `ctx.reload()` 先替换旧诊断，再重新收集（包含此次 `session_start` 错误）。模型 fallback 等待 startup preferences 的恢复流程结束后判断，恢复成功不告警。扩展原始诊断作为服务端详情保留原文，应用的摘要和错误外围文案走 i18n。

## Fork 与扩展对话框

消息 Fork 和 `/clone` 在复制锁之外询问已绑定的 `session_before_fork`，分别使用目标消息 `before` 和 leaf `at`。扩展取消不写文件，Clone 的扩展取消不显示“空会话”错误。Stop 期间被 SDK 吞掉的对话框异常也按取消处理；等待结束后重新检查忙碌状态、删除预留及目标。保留本项目禁止运行中消息 Fork/Clone 的规则，侧栏磁盘 Fork、fork_branch 和 side chat 不询问扩展。

prompt、reload、tree navigation 和 compact 都会更新此前 Stop 已取消的 UI controller。SDK 的 tree hook 内部吞掉异常后仍可能移动分支；本改动不接管 SDK 的树导航事务。

## 编辑器文本

`setEditorText` 只替换可编辑文本（空字符串可清空），通过现有 textarea 选区替换 helper 完成一次原生 undo 操作。引用卡片、图片附件和图片路径引用独立于文本，不在替换范围内；这使扩展无法意外抹掉用户挑选的上下文。`pasteToEditor` 使用独立的 `editor_paste` 页面事件，在光标/选区插入原文，不补空格；空粘贴不修改文本和选区。未支持 execCommand 的浏览器沿用现有 setRangeText 降级，原生 undo 不保证。

## Stop 与队列

Stop 和 Recall 在同一同步步骤读取 Agent 的真实投递队列、恢复文本和图片，再清空 SDK 队列并合并手动 compaction 暂存队列；已经投递的公共字符串不作为恢复来源。Stop 的返回值同时清空发起页面的本地队列 UI，断开 SSE 时也不会留下旧行。

Recall 对不可恢复内容仍然 fail-closed。Stop 遇到解析失败也会执行 abort，但不破坏原队列，并报告错误。Stop 对扩展 custom 消息使用 SDK 的 `sendCustomMessage(..., { triggerTurn: false })`：保留 custom 类型、display 和 details，交由 SDK 在工具结果之后写入历史，不伪装成用户草稿、不启动下一轮。隐藏消息保持隐藏。
