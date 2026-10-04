# Pi Web - Development Notes

**What belongs here:** commands, environment, safety rules, and traps a reader of the code would get wrong. Feature specs, UX details, and design rationale go to `docs/*.md` or `docs/adr/`; rules already enforced by a test get one line pointing at the test. Keep entries short.

Design docs: `docs/subagents.md`, `docs/settings.md` (MCP, plugins, skills, project overrides, usage), `docs/ui.md` (typography, modals, panels, images), `docs/image-generation.md`, `docs/worktrees.md`, `docs/terminal.md`, `docs/chat-tabs.md`, `docs/i18n.md`, `docs/adr/`.

## Quick Start

```bash
npm run dev   # port 30143 (remote: https://nuc.tailb8ef79.ts.net:10446)
```

- Typecheck: `node_modules/.bin/tsc --noEmit`; lint: `npm run lint`.
- Remote access needs `PI_WEB_ALLOWED_HOSTS=nuc.tailb8ef79.ts.net`, otherwise `proxy.ts` answers `403 Untrusted host` (DNS-rebinding guard). Already exported in `~/.zshenv` and this checkout's git-ignored `.env.development.local`; systemd services set it themselves.
- `next build` coexists with the dev server (`.next/` vs `.next/dev/`).

### Testing policy

- Small, local changes: run only directly relevant tests and `git diff --check`.
- Run the full `npm test` once after a batch of changes, before release, for cross-cutting/high-risk changes, or when asked — not after every edit.

### Stable service protection

- Port 30141 (tailscale :10443) is the stable npm-installed service (`~/.npm-global/.../@calmabacus/pi-web`), running its own packaged `.next`. This checkout is dev only (30143).
- **Never stop/restart 30141, bind anything to it, or run `npm run start` from this checkout without explicit user confirmation.**
- Dev and the service share `~/.pi/agent` (sessions, auth, models.json, skills, plugins). Destructive actions in dev hit the user's real data.
- Upgrades: verify in dev, publish to npm, update the global package, then output the exact restart command for the user to run.

### Dev server troubleshooting

- Before starting, run `lsof -nP -iTCP:30143 -sTCP:LISTEN` and reuse a healthy process. A second `next dev` for this checkout cannot use another port: both contend for `.next/dev/lock`.
- A browser-only `Module ... factory is not available` overlay is usually a stale HMR graph in that tab. Reload the page first, then compare the server log and a direct HTTP/API request.
- Restart only if it reproduces on a fresh page and server-side checks also fail: stop the exact dev process gracefully, move `.next` into a `mktemp -d` backup, `npm run dev`.
- Never use `next dev --webpack` (fails on `undici` imports such as `node:console`).
- After editing `app/globals.css`, Turbopack may keep serving a stale CSS chunk (classes renamed without their rules). Confirm with `document.styleSheets`; appending/removing a comment forces a rebuild.
- After an SDK upgrade, restart the dev server: a server started before `npm install` keeps old modules (MCP config helpers then fail with missing-export errors).
- `next dev` may append a generated `BEGIN:nextjs-agent-rules` block to this file. Do not commit it with unrelated work.

---

## Architecture

```
Browser                Next.js Server              AgentSession (in-process)
  ├─ GET /api/sessions ────▶ reads ~/.pi/agent/sessions/   │
  ├─ GET /api/sessions/[id] reads .jsonl file directly     │
  ├─ POST /api/agent/[id] ─▶ startRpcSession() ───────────▶│ createAgentSession()
  │                        │   session.send(cmd) ─────────▶│ session.prompt()
  ├─ SSE ──────────────────▶ GET /api/agent/[id]/events    │
  │◀── data: {...} ─────────│   session.onEvent() ◀─────────│ session.subscribe()
```

- Session browsing is read-only (`SessionManager` helpers + `lib/session-reader.ts`), no AgentSession created.
- Layout: `app/api/**/route.ts` endpoints, `lib/` server logic and shared helpers, `components/`, `hooks/`. Key entry points: `lib/rpc-manager.ts` (wrapper/registry/`startRpcSession`), `hooks/useAgentSession.ts` (messages, streaming, SSE, reconciliation), `components/AppShell.tsx` (layout, URL state, tabs), `lib/path-security.ts` (file access boundary).

---

## Key Design Decisions & Traps

### AgentSession lifecycle (`lib/rpc-manager.ts`)
- One `AgentSessionWrapper` per session id in `globalThis.__piSessions` (`globalThis` survives hot reload; a module-level Map does not). Concurrent `startRpcSession()` calls share one start Promise (`globalThis.__piStartLocks`).
- Idle timeout 10 min (`PI_WEB_IDLE_TIMEOUT_MS`). Visible-pane SSE subscribes with `onEvent(listener, keepAlive=true)` and keeps the runtime alive (also needed for extension UI dialogs); unviewed idle runtimes are disposed and recreated from `session_start` replay.
- Stop always aborts work; observer lifetime must not block abort.

### Fork must destroy the wrapper immediately
`AgentSession.fork()` mutates the wrapper in place: afterwards `inner.sessionId` is the *new* id. Left in the registry under the old id, the next request gets forked state and later forks corrupt the `parentSession` chain. `send("fork")` captures `newSessionId`, then calls `this.destroy()`.

### Two kinds of branching
- **Fork** (new `.jsonl`; `parentSession` is display metadata only, so rewriting the whole file on delete is safe). The user-message button forks *before* that message. `⋯` / sidebar Fork session and `POST /api/sessions/[id]/fork` copy the viewed branch *through* the leaf (`lib/session-fork.ts` opens a fresh `SessionManager`; never call `createBranchedSession` on a live wrapper). Forks stay top-level in the sidebar.
- **In-session branch** (Continue / BranchNavigator): `navigate_tree` within the same file; siblings share `parentId`; switching loads `/api/sessions/[id]/context?leafId=`.

### ToolCall field normalization
Pi stores `{type:"toolCall", id, name, arguments}`; our `ToolCallContent` is `{toolCallId, toolName, input}`. `normalizeToolCalls()` (`lib/normalize.ts`) runs on file load and on streaming events.

### Tool presets
`toolNames[]` is passed at creation (`POST /api/agent/new`) and persisted as versioned `pi-web:tool-selection` custom entries. No entry = legacy session (Pi default); empty array = Chat only, which loads no extensions/skills/prompts/themes and replaces Pi's base prompt with the context files. Crossing the Chat-only boundary rebuilds the wrapper. The browser-stored last preset only initializes fresh composers; existing sessions use live `get_tools`. See `docs/adr/0002-chat-only-tool-selection.md`.

### Models
- `defaultModel` comes from `~/.pi/agent/settings.json`. Explicit model/thinking choices are applied atomically at AgentSession construction and then persisted by `lib/startup-preferences.ts` (no `set_model` replay); implicit `enabledModels` fallbacks are not persisted. In-session `set_model`/`set_thinking_level` persist (`persist: true`). The composer shows the concrete effective thinking level, never `auto`.
- `enabledModels` uses pi's `--models` syntax (globs, fuzzy match, `:thinkingLevel` suffix). Never compare as literal strings: `lib/model-scope.ts` delegates to the SDK's `resolveModelScopeWithDiagnostics()`.
- `defaultTools` may be a `+name`/`-name` delta: read via `SettingsManager.getDefaultTools()` or `resolveDefaultTools()` (`lib/powershell-settings.ts`), never as a plain list.

### Built-in extensions (MCP, codemode, tool search)
- SDK sessions get no built-in extensions, so `startRpcSession()` adds `mcp`, `codemode`, `tool-search` as `{ builtin: true, replaceable: true }` (CLI semantics: `-builtin:<name>` disables; an installed extension registering `/mcp` replaces it). Chat only and sub-agents load none.
- MCP `codemode`/`deferred` tools stay callable regardless of the active set, so `lib/read-only-tool-guard.ts` blocks every MCP call under the read-only preset. Never trust `readOnlyHint`.
- pi's MCP config/CLI helpers are not exported by the SDK; `lib/mcp-config.ts` loads them by file path with `webpackIgnore`/`turbopackIgnore`. Details: `docs/settings.md`.

### Extension UI
- No persistent TUI widgets: `setWidget` is a compatibility no-op (string arrays emitted and ignored, factories never invoked).
- Supported: `select`/`confirm`/`input`/`editor`/`custom()`, notify/status/title/editor-text, pending dialog replay. `ctx.ui.theme` is `WebExtensionTheme`; `custom()` gets `PlainTextTheme`; `getToolsExpanded()` is always false.
- Idle `/api/sessions/[id]/state` is `{ running: false }` with no `state` object.

### Running state and reconciliation
- Per-session SSE is primary. After `prompt_done`, unviewed runs keep a 30 s grace window; `agent_start` cancels the close timer; `agent_settled` finishes extension-injected runs. **Never close on the first `agent_end`**: retries, compaction, and queued messages continue the same logical prompt.
- While running, `useAgentSession` polls `GET /api/agent/[id]` and reconciles on `visibilitychange`/`online` to recover missed terminal events. Prompt runs carry a monotonic run id; ignore late events from old runs.
- Accept both `compaction_start/end` and legacy `auto_compaction_start/end`.
- The sidebar polls `/api/agent/running` every 2.5 s while visible.

### Paths, worktrees, file access
- Linked worktrees resolve to the main repo `projectRoot` (`lib/worktree.ts`) so the sidebar groups them; sessions in removed worktrees fold back into the main project. See `docs/worktrees.md`.
- git prints POSIX paths even on Windows: pass every git path through `toNativePath()` (`lib/paths.ts`) and compare with `samePath()`, never `===`. Branch names are not paths. Browser code cannot apply Node path rules, so `/api/worktrees` returns `currentWorktreePath`.
- `/api/files` is not a general filesystem browser: allowed roots are session cwds, their project roots, and `allowFileRoot()` additions. `isPathWithinRoots()` (`lib/path-security.ts`) is the single security boundary; keep one implementation.

### Settings pages (plugins, skills, project overrides)
Full notes: `docs/settings.md`. Traps:
- Project overrides (`lib/project-resource-overrides.ts`) always write per-item patterns, never `!**` (the pi TUI reads only per-item entries). Package resources become `{ source, autoload: false, <type>: [...] }` deltas; without `autoload: false` the entry replaces the package.
- pi reads only `<cwd>/.pi/settings.json`, so `lib/project-override-sync.ts` replays overrides into every worktree checkout (not a file copy: local sources are relative).
- Skill `disable-model-invocation` edits only that frontmatter key (keep user formatting). Package skills are refused with 409.
- Writes into project `.pi/` (overrides, `mcp.json`, `.pi/agents`) are project-trust gated.

### Built-in subagents
Full notes: `docs/subagents.md`, `docs/adr/0003-built-in-subagent-toggle.md`. Traps:
- `builtInEnabled` in `~/.pi/agent/agents/settings.json` defaults to true; malformed settings fail closed. A per-project override wins over the global default. The factory is always present but registers no tools while disabled; users must reload the session after a change, and `Agent` dispatch re-checks the setting.
- `Agent`, `get_subagent_result`, `steer_subagent` are reserved; `generate_image` is reserved for Pi Web.
- Agent profile files may be shared with other runtimes: saves must round-trip frontmatter keys this app does not manage. Imports byte-copy files, never through the form.

### Auth
- Provider listing is capability-driven (`lib/provider-listing.ts`), never by provider id: dual-auth providers must appear exactly once (#309).
- auth.json holds one credential per provider and `logout()` deletes whichever it is; delete routes use `removeStoredCredentialIfType()` under pi's auth file lock. Refresh *both* provider lists after any auth change.
- Status endpoints never return raw keys. The model test route is `app/api/models-config/test/route.ts`.

### UI rules (details: `docs/ui.md`)
- Modals go through `components/ModalDialog.tsx`; confirms through `useConfirm()`. `window.confirm`/`alert` are banned (tested).
- Typography (enforced by `components/Typography.test.mjs`): fonts by role — `--font-ui` chrome, `--font-chat` prose, `--font-mono` only for verbatim content; only weights 400/600, 600 for headings only; never show state with weight or italic; sizes from the shared scale; three text tiers, no opacity fading; clipped text needs `line-height` >= 1.3. Fonts are bundled in `public/fonts`; bump `?v=` when replacing one.
- Images: never render a raw `<img>` in a message; use the image components. Image order is the order sent to the model (`attachment:N`).
- Corners use `--ui-radius-sm` (4px, chips/small buttons/inline code), `--ui-radius-md` (6px, controls/rows/menus/code blocks/images), `--ui-radius-lg` (10px, dialogs and settings cards). Pills `999px`, dots `50%`.

---

## Pi Session File Format

Location: `~/.pi/agent/sessions/<encoded-cwd>/<timestamp>_<uuid>.jsonl`

```jsonl
{"type":"session","version":3,"id":"<uuid>","timestamp":"...","cwd":"/path","parentSession":"/abs/path/to/parent.jsonl"}
{"type":"model_change","id":"<8hex>","parentId":null,"provider":"zenmux","modelId":"claude-sonnet-4-6","timestamp":"..."}
{"type":"message","id":"<8hex>","parentId":"<8hex>","message":{"role":"user","content":"..."}}
{"type":"message","id":"<8hex>","parentId":"<8hex>","message":{"role":"assistant","content":[...],...}}
{"type":"message","id":"<8hex>","parentId":"<8hex>","message":{"role":"toolResult","toolCallId":"...","content":[...]}}
{"type":"compaction","id":"<8hex>","parentId":"<8hex>","summary":"...","firstKeptEntryId":"<8hex>","tokensBefore":N}
{"type":"session_info","id":"...","parentId":"...","name":"user-defined name"}
```

`entryIds[]` in `SessionContext` parallels `messages[]`, mapping each displayed message to its `.jsonl` entry id (used for fork and `navigate_tree`).
