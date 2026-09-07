# 目录树与关键文件清单

研究基准：PI-Desktop `1d94d8ad38e53562187be2e246d798835b558b92`

## PI-Desktop

```text
apps/desktop/
├── src/
│   ├── App.tsx
│   ├── components/
│   │   ├── Sidebar.tsx
│   │   ├── Composer.tsx
│   │   ├── ChatTranscript.tsx
│   │   ├── ConversationMinimap.tsx
│   │   ├── SearchDialog.tsx
│   │   ├── NotificationCenter.tsx
│   │   ├── PlanApprovalBar.tsx
│   │   ├── AskToolCard.tsx
│   │   └── workpanel/WorkPanel.tsx
│   └── stores/app-store.ts
├── electron/main/
│   ├── index.ts
│   ├── agent-sidecar.ts
│   ├── browser-view.ts
│   ├── git-diff.ts
│   ├── notification-policy.ts
│   └── plugin-runtime.ts
└── resources/plugins/

crates/host-core/
packages/agent-runtime/
packages/shared/
docs/
├── guide/screenshots.md
├── spec/04-ux/01-ui-ia.md
└── adr/
```

重点 ADR：

- `0016-sidebar-organization-and-multi-project-tabs.md`
- `0017-remove-composer-workspace-context-rail.md`
- `0019-work-panel-subsystems.md`
- `0024-composer-commands-and-file-references.md`
- `0034-merge-command-palette-into-global-search.md`
- `0042-message-scoped-inline-review-cards.md`
- `0047-context-usage-inspector.md`
- `0061-imperceptible-background-context-compaction.md`
- `0065-smooth-shell-layout-and-stream-feedback.md`
- `0066-empty-home-direct-bottom-composer.md`
- `0073-next-turn-composer-configuration-and-stopped-throughput.md`
- `0077-asktool-interactive-multi-question-flow.md`
- `0118-renderer-owned-queued-prompts.md`
- `0120-bounded-session-history-windows.md`

## Pi Web

```text
components/
├── AppShell.tsx
├── SessionSidebar.tsx
├── ChatWindow.tsx
├── ChatInput.tsx
├── ModelSelector.tsx
├── MessageView.tsx
├── TurnWrittenFiles.tsx
├── ChatMinimap.tsx
├── ChatTabBar.tsx
├── TabBar.tsx
├── FileExplorer.tsx
├── FileViewer.tsx
├── TerminalPanel.tsx
└── SettingsPanel.tsx

hooks/
└── useAgentSession.ts

lib/
├── chat-tab-state.ts
├── panel-layout.ts
├── project-groups.ts
├── turn-written-files.ts
└── worktree.ts
```

主要比较落点：

- Shell 和顶部密度：`components/AppShell.tsx`
- Composer 密度与补全：`components/ChatInput.tsx`
- 模型列表规模：`components/ModelSelector.tsx`
- 会话/文件空间争用：`components/SessionSidebar.tsx`
- 本轮产物入口：`components/TurnWrittenFiles.tsx`
- Diff 复用能力：`components/FileViewer.tsx`
- 长会话与过程披露：`components/ChatWindow.tsx`
