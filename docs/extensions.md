# Web 扩展兼容

## 编辑器文本

`setEditorText` 只替换可编辑文本（空字符串可清空），通过现有 textarea 选区替换 helper 完成一次原生 undo 操作。引用卡片、图片附件和图片路径引用独立于文本，不在替换范围内；这使扩展无法意外抹掉用户挑选的上下文。`pasteToEditor` 使用独立的 `editor_paste` 页面事件，在光标/选区插入原文，不补空格；空粘贴不修改文本和选区。未支持 execCommand 的浏览器沿用现有 setRangeText 降级，原生 undo 不保证。

## Stop 与队列

Stop 和 Recall 在同一同步步骤读取 Agent 的真实投递队列、恢复文本和图片，再清空 SDK 队列并合并手动 compaction 暂存队列；已经投递的公共字符串不作为恢复来源。Stop 的返回值同时清空发起页面的本地队列 UI，断开 SSE 时也不会留下旧行。

Recall 对不可恢复内容仍然 fail-closed。Stop 遇到解析失败也会执行 abort，但不破坏原队列，并报告错误。Stop 对扩展 custom 消息使用 SDK 的 `sendCustomMessage(..., { triggerTurn: false })`：保留 custom 类型、display 和 details，交由 SDK 在工具结果之后写入历史，不伪装成用户草稿、不启动下一轮。隐藏消息保持隐藏。
