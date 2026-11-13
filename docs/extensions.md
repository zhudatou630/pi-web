# Web 扩展兼容

## Stop 与队列

Stop 和 Recall 在同一同步步骤读取 Agent 的真实投递队列、恢复文本和图片，再清空 SDK 队列并合并手动 compaction 暂存队列；已经投递的公共字符串不作为恢复来源。Stop 的返回值同时清空发起页面的本地队列 UI，断开 SSE 时也不会留下旧行。

Recall 对不可恢复内容仍然 fail-closed。Stop 遇到解析失败也会执行 abort，但不破坏原队列，并报告错误。Stop 对扩展 custom 消息使用 SDK 的 `sendCustomMessage(..., { triggerTurn: false })`：保留 custom 类型、display 和 details，交由 SDK 在工具结果之后写入历史，不伪装成用户草稿、不启动下一轮。隐藏消息保持隐藏。
