# 关键文件

研究对象：

- Pi Web 当前工作区
- 本机 `@tintinweb/pi-subagents` 0.19.0

## Pi Web

- `lib/subagent-extension.ts`：三个模型工具及 foreground/background 交付语义
- `lib/subagent-runtime.ts`：AgentSession 创建、上下文、限额、结果判定
- `lib/subagents.ts`：profile、资源快照、持久结果
- `lib/subagent-prompt.ts`：system prompt 和 inherited context 组合
- `lib/rpc-manager.ts`：子会话注册、恢复和运行状态
- `components/AgentSessionPanel.tsx`：主/子会话切换和状态显示
- `components/AgentsConfig.tsx`：profile 设置界面

## tintinweb/pi-subagents

- `src/index.ts`：工具、通知、consume、join、UI 和命令入口
- `src/agent-manager.ts`：任务记录、并发队列、停止、恢复和清理
- `src/agent-runner.ts`：AgentSession 创建、turn limit、结果提取
- `src/prompts.ts`：parent twin / replace 两种系统提示结构
- `src/context.ts`：语义化父对话提取
- `src/group-join.ts`：后台完成结果合并
- `src/status-note.ts`：partial/stopped/aborted/steered 的诚实表达
- `src/abortable.ts`：取消等待但不取消后台任务
- `src/types.ts`：AgentRecord 任务状态模型
- `src/default-agents.ts`：general-purpose、Explore、Plan 的默认边界

本机包路径：

`~/.pi/agent/npm/node_modules/@tintinweb/pi-subagents/`