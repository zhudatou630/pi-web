# Pi Web - Development Notes

## Quick Start

```bash
npm run dev   # port 30143 (remote: https://nuc.tailb8ef79.ts.net:10446)
```

Remote access through the tailscale hostname needs `PI_WEB_ALLOWED_HOSTS=nuc.tailb8ef79.ts.net`; otherwise `proxy.ts` answers `403 Untrusted host "..."` (DNS-rebinding guard). It is exported in `~/.zshenv` (covers every checkout/worktree started from zsh) and in this checkout's git-ignored `.env.development.local` (covers bash-launched dev servers). The systemd services set it themselves.

Port 30141 is the stable npm-installed service (`~/.npm-global/.../@calmabacus/pi-web`, remote via tailscale :10443) — this checkout is for development only. Do not run `npm run start` from this checkout; it would collide with that service.

Typecheck: `node_modules/.bin/tsc --noEmit`  
Lint: `npm run lint`  
`next build` coexists with the dev server: production output goes to `.next/` root while Turbopack dev uses `.next/dev/`. A running dev server survives a build, and `npm run dev` restarts cleanly afterward (verified on Next 16).

### Testing policy

- For small, local changes, run only directly relevant tests and `git diff --check`.
- Do not run the full `npm test` suite after every incremental change.
- Run the full suite once after a batch of changes, before release, or when the user explicitly requests it.
- Broader tests are appropriate for cross-cutting or high-risk changes; state why they are needed.

### Dev server troubleshooting

- Before starting a dev server, run `lsof -nP -iTCP:30143 -sTCP:LISTEN` and reuse the existing healthy dev process. A second `next dev` for the same checkout cannot use a different port as a workaround because both processes contend for `.next/dev/lock`.
- Port 30141 belongs to the stable npm service, not this checkout. Never bind dev to 30141 and never kill that process to free it.
- A browser-only `Module ... factory is not available` overlay usually means that tab has a stale Turbopack/HMR graph; it does not prove the server or source is broken. First call the browser's explicit reload action, then compare the current server log and a direct HTTP/API request.
- Restart only after the failure reproduces from a fresh page and the server-side checks also fail. Stop the exact dev process gracefully, move `.next` into a `mktemp -d` backup, and restart with the standard `npm run dev` command.
- Do not use `next dev --webpack` as a fallback. This repository's development graph can fail on `undici` imports such as `node:console`; development is expected to use Turbopack.
- Next.js may append a generated `BEGIN:nextjs-agent-rules` block to `AGENTS.md` when `next dev` starts. Treat that as generated tooling output, verify it with `git status`, and do not include it in an unrelated feature commit.

### Production & Service Runtime Protection

Topology on this machine: the stable service is the global npm install on 127.0.0.1:30141 (tailscale :10443); this checkout's dev server runs on 30143 (tailscale :10446). Repo builds/dev runs cannot corrupt the service because it executes the packaged `.next` under `~/.npm-global`, not this checkout's `.next/`.

- **Never stop/restart the 30141 service or bind anything to 30141 without explicit user confirmation.**
- Dev and the stable service share `~/.pi/agent` (sessions, auth, models.json, skills, plugins). Destructive actions in dev — deleting sessions, editing models/skills, installing plugins — hit the user's real data.
- Upgrades ship through npm release: verify in dev, publish, update the global package, then output the exact restart command and let the user execute it.

---

## Architecture

```
Browser                Next.js Server              AgentSession (in-process)
  │                        │                               │
  ├─ GET /api/sessions ────▶ reads ~/.pi/agent/sessions/   │
  ├─ GET /api/sessions/[id] reads .jsonl file directly     │
  ├─ GET /api/agent/running ───────▶ running id snapshot   │
  │                        │                               │
  ├─ send message ─────────▶ POST /api/agent/[id]          │
  │                        │   startRpcSession() ─────────▶│ createAgentSession()
  │                        │   session.send(cmd) ─────────▶│ session.prompt()
  │                        │                               │
  ├─ SSE connect ──────────▶ GET /api/agent/[id]/events    │
  │                        │   session.onEvent() ◀─────────│ session.subscribe()
  │◀── data: {...} ─────────│                               │
```

**Session browsing** (read-only): reads `.jsonl` files through SDK `SessionManager` helpers and `lib/session-reader.ts` — no AgentSession created. Sidebar/list/history endpoints stay lightweight.
**Visible interactive chat pane**: `GET /api/agent/[id]/events` starts or attaches a runtime and keeps it from idle disposal while the view is connected.
**Sending a message**: `startRpcSession()` in `lib/rpc-manager.ts` creates an AgentSession in-process.

---

## File Map

```
app/api/
  sessions/route.ts               GET  list all sessions
  sessions/[id]/route.ts          GET/PATCH/DELETE session
  sessions/[id]/context/route.ts  GET ?leafId= — context for a specific leaf
  sessions/[id]/export/route.ts   GET exported HTML for a session
  agent/new/route.ts              POST { cwd, message, toolNames?, provider?, modelId? }
  agent/[id]/route.ts             GET state | POST any command
  agent/[id]/events/route.ts      GET SSE stream
  agent/running/route.ts          GET currently-running session ids
  auth/api-key/[provider]/route.ts POST/DELETE provider API key storage
  auth/login/[provider]/route.ts  GET OAuth/device-code SSE | POST manual code
  auth/logout/[provider]/route.ts POST OAuth logout
  auth/providers/route.ts         GET OAuth and API-key provider lists
  cwd/validate/route.ts           POST validate/select a cwd
  default-cwd/route.ts            POST create ~/pi-cwd-YYYYMMDD
  files/[...path]/route.ts        GET file contents for viewer
  home/route.ts                   GET user home directory
  models/route.ts                 GET { models, modelList, defaultModel }
  models-config/route.ts          GET/PUT — read/write ~/.pi/agent/models.json
  models-config/catalog/route.ts  GET models.dev pricing presets
  models-config/discover/route.ts POST fetch a configured provider's upstream model list
  models-config/test/route.ts     POST test a configured model/provider
  plugins/route.ts                GET/POST package plugin management
  projects/route.ts               DELETE { projectKey } — delete every session of one sidebar project
  skills/route.ts                 GET/PATCH loaded skills and disable-model-invocation
  skills/install/route.ts         POST install skills through npx skills add
  skills/search/route.ts          GET/POST skills.sh search
  subagents/settings/route.ts     GET/PUT built-in subagent feature setting
  worktrees/route.ts              GET/POST/DELETE git worktrees
  usage/route.ts                  GET token/cost report for the Settings > Usage page

lib/
  agent-client.ts      typed fetch helper for /api/agent commands
  draft-store.ts       local draft persistence helpers
  file-access.ts       allowed file roots for /api/files and worktrees
  file-paths.ts        client/server path encoding helpers
  markdown.ts          shared markdown helpers
  npx.ts               npx runner used by skill install
  pi-types.ts          local structural types for pi SDK objects
  rpc-manager.ts      AgentSessionWrapper + registry + startRpcSession
  custom-ui-terminal.ts headless terminal dimensions for custom()
  session-reader.ts   SessionManager wrappers + path cache + buildSessionContext adapter
  subagent-settings.ts  read/write ~/.pi/agent/agents/settings.json
  tool-presets.ts     PRESET_NONE/READ_ONLY/DEFAULT/FULL + getPresetFromTools()
  tool-preset-preference.ts  browser-persisted default for fresh sessions
  types.ts            shared TypeScript types
  normalize.ts        normalizeToolCalls() — field name mismatch between file format and our types
  worktree.ts         project/worktree resolution and git worktree operations

components/
  AppShell.tsx        layout + URL state + tab management
  SessionSidebar.tsx  session tree + FileExplorer
  ChatWindow.tsx      chat composition + completion sound wrapper
  ChatInput.tsx       input bar + model/thinking/tools/compact controls
  ChatTabBar.tsx      chat session tab strip & multi-tab navigation
  MessageView.tsx     renders one message (user/assistant/toolCall/toolResult)
  BranchNavigator.tsx in-session branch switcher
  ChatMinimap.tsx     scroll minimap alongside the message list
  MarkdownBody.tsx    markdown renderer
  ModelsConfig.tsx    modal for editing models.json (opened from sidebar bottom)
  AgentsConfig.tsx    built-in subagent toggle + agent profile editor
  PluginsConfig.tsx   modal for installed package plugins
  SkillsConfig.tsx    modal for loaded/search/installable skills
  FileExplorer.tsx    file tree inside sidebar
  FileIcons.tsx       file icon helpers
  FileViewer.tsx      file content in a tab
  SessionSearch.tsx   session search modal across conversation histories
  SettingsPanel.tsx   general workspace preferences and settings
  TerminalPanel.tsx   in-browser terminal tab with PTY streaming
  DirectoryPicker.tsx working directory navigation dialog
  TabBar.tsx          tab bar (Chat + open file tabs)

hooks/
  useAgentSession.ts  messages + streaming + SSE + fork/navigate/reconciliation logic
  useAudio.ts         completion sound + browser AudioContext unlock
  useDragDrop.ts      shared drag/drop state
  useIsMobile.ts      responsive breakpoint hook
  useTheme.ts         theme state
```

---

## Key Design Decisions & Traps

### AgentSession lifecycle (`lib/rpc-manager.ts`)
- One `AgentSessionWrapper` per session id, keyed in `globalThis.__piSessions`
- `globalThis` survives Next.js hot-reload; plain module-level Map does not
- Idle timeout: 10 minutes. Visible-pane SSE subscribers call `onEvent(listener, keepAlive=true)` and keep an idle runtime from disposal; unviewed idle runtimes may be disposed and recreated from `session_start` replay. Concurrent `startRpcSession()` calls share a single start Promise (`globalThis.__piStartLocks`)
- Stop still aborts work. Observer lifetime must not block abort.

### Fork must destroy the wrapper immediately
`AgentSession.fork()` **mutates the wrapper's inner state in-place** — after fork, `inner.sessionId` is the *new* session's id. If the wrapper stays alive in the registry under the old id, the next request gets the already-forked state and subsequent forks produce a corrupt `parentSession` chain.

**Fix**: `send("fork")` captures `newSessionId`, then calls `this.destroy()` before returning. The next request for the original session reloads a clean AgentSession from the original file.

### Two kinds of branching — don't confuse them
- **Fork** (Fork button on user message): creates a new independent `.jsonl` file. Shown as a child in the sidebar tree via `parentSession` header field.
- **In-session branch** (Continue button / BranchNavigator): calls `navigate_tree` within the same file. Multiple entries share the same `parentId`. Switching between them calls `/api/sessions/[id]/context?leafId=`.

### Session files can be fully rewritten
`parentSession` in the header is **display metadata only** — has zero effect on chat content. Safe to `writeFileSync` the entire file (pi does this itself during migrations). Used when cascade-reparenting children on delete.

### ToolCall field normalization
Pi stores toolCall blocks as `{type:"toolCall", id, name, arguments}` but `ToolCallContent` uses `{toolCallId, toolName, input}`. `normalizeToolCalls()` in `lib/normalize.ts` handles this — called in both `session-reader.ts` (file load) and `ChatWindow.handleAgentEvent()` (streaming).

### New session tool preset
Tool names are passed at session creation (`POST /api/agent/new` -> `toolNames[]`) and persisted in versioned `pi-web:tool-selection` custom entries. No entry means a legacy session and keeps Pi's default behavior; an empty array means Chat only. Chat only resolves before services are created, loads no extensions/skills/prompts/themes, and replaces Pi's base prompt with the ordered contents of Pi's discovered context files. Crossing the Chat-only boundary rebuilds the wrapper; changing between nonempty presets updates it in place. Subagents persist their active tools plus profile-level skill and extension loading switches in `resourceSnapshot`; loaded extensions cannot expose the reserved `Agent`, `get_subagent_result`, or `steer_subagent` tools to a subagent. See `docs/adr/0002-chat-only-tool-selection.md`.

The last preset explicitly selected by the user is stored in browser `localStorage` and initializes fresh-session composers only. Existing sessions never trust that preference; they use their live `get_tools` state or pi's default when no wrapper exists.

### Model defaults for new sessions
`GET /api/models` returns `defaultModel` read from `~/.pi/agent/settings.json`. `ChatWindow` pre-selects this on mount for new sessions. Explicit browser model/thinking selections are applied atomically during AgentSession construction, then `lib/startup-preferences.ts` persists their effective values without replaying `set_model`/`set_thinking_level`; implicit `enabledModels` fallbacks and thinking pins are not persisted. In-session `set_model` / `set_thinking_level` persist too (`persist: true`), so new sessions reuse the last explicit model and effort; unlike pi's TUI, effort is remembered without a separate "set as default". The composer always shows the concrete effective level (no `auto`): new sessions resolve pin → `defaultThinkingLevel` clamped to the model from `GET /api/models`.

### `enabledModels` scoping
The `enabledModels` setting uses pi's `--models` syntax: minimatch globs against `provider/modelId` or a bare `modelId`, fuzzy matching for non-glob patterns, and an optional `:thinkingLevel` suffix. Never compare those patterns as literal strings — `lib/model-scope.ts` delegates to the SDK's `resolveModelScopeWithDiagnostics()` so pi-web and the TUI agree on the visible model list, and falls back to all available models when patterns resolve to nothing. `startRpcSession()` resolves that scope before creating an AgentSession and passes the selected initial model, thinking pin, and SDK-native `scopedModels` atomically; `GET /api/models` reuses the helper only for selector data, `thinkingLevelPins`, and `modelScopeWarnings` display.

### Extension UI (no persistent widgets)
- Web does not display persistent TUI widgets. `setWidget` remains as a compatibility RPC method: string arrays are fire-and-forget `extension_ui_request` events the browser ignores; factories are not invoked; nothing is cached or rendered.
- Other extension interactions stay supported: `select` / `confirm` / `input` / `editor` / `custom()`, plus notify / status / title / editor-text RPC, keyboard/focus/cancel/Stop, pending dialog replay, and normal chat SSE.
- `ctx.ui.theme` is `WebExtensionTheme` (accent 34 / success 32 / error 31 / warning 33 / muted 90 / other 39). `custom()` keeps the unstyled `PlainTextTheme`. `getToolsExpanded()` is always false.
- Visible-pane SSE calls `onEvent(listener, keepAlive=true)` so the runtime stays live for startup dialogs and other extension UI; this is a generic UI subscription marker, not a widget view.
- Idle `/api/sessions/[id]/state` is `{ running: false }` with no `state` object.

### SSE reconnect on page refresh mid-stream
On `ChatWindow` mount, the visible pane connects SSE (which starts the runtime if needed). `GET /api/agent/[id]` still reconciles streaming/thinking/compaction.

### Compaction SSE events
Newer pi emits `compaction_start` / `compaction_end`; older versions emitted `auto_compaction_start` / `auto_compaction_end`. `handleAgentEvent` accepts both sets to keep `isCompacting` in sync. Manual compact is a blocking POST — the button stays disabled until the response returns.

### Running state polling + reconciliation
- The sidebar polls `/api/agent/running` every 2.5 seconds while the tab is visible and pauses polling in background tabs. The session-list response remains the initial fallback.
- `useAgentSession` treats per-session SSE as primary. A visible interactive chat pane stays subscribed so extension UI and idle updates converge; unviewed runs keep the 30-second grace window after `prompt_done` for completion. `agent_start` cancels that close timer; `agent_settled` finishes extension-injected runs that have no wrapper-level `prompt_done` and starts a fresh grace window for unviewed runs. Do not close on the first `agent_end`: retries, compaction, and extension-queued messages can continue the same logical prompt.
- While a run is active, `useAgentSession` periodically calls `GET /api/agent/[id]` and also reconciles on `visibilitychange`/`online`. This fixes missed terminal events from background tabs or half-open connections.
- Prompt runs use a monotonic run id; late SSE or slow reconciliation responses from an old run must be ignored so they cannot resurrect stale streaming bubbles.

### Worktrees and project grouping
- `lib/worktree.ts` resolves linked worktree top-levels back to the main repo `projectRoot`; `listAllSessions()` attaches that to each `SessionInfo` so all worktrees for one repo are grouped together in the sidebar.
- Worktree operations are served by `/api/worktrees` and guarded by the same allowed-root rules as `/api/files`.
- New worktrees are created under `<repoRoot>-worktrees/<sanitized-branch>`. Existing branches are reused; otherwise `git worktree add -b` creates the branch.
- Removing a dirty worktree returns `409` with `{ dirty: true }` so the UI can ask before retrying with `force`.
- Sessions whose cwd points at a removed worktree are inferred back into the main project instead of becoming a phantom project row.
- git prints POSIX-style absolute paths even on Windows, so every path read out of git goes through `toNativePath()` (`lib/paths.ts`) before it is compared or returned. Compare paths with `samePath()`, never `===` — raw equality made `isTopLevel` permanently false on Windows and hid the worktree switcher entirely. Branch names are not paths and must keep their forward slashes. Browser code cannot apply Node path rules, so `/api/worktrees` resolves `currentWorktreePath` server-side; the sidebar must use that identity for highlighting and removal fallback.

### File access allow-list
- `/api/files` is intentionally not a general filesystem browser. Allowed roots come from session cwds, their resolved project roots, `~/pi-cwd-*`, and roots explicitly added with `allowFileRoot()`.
- `/api/cwd/validate`, `/api/default-cwd`, and `/api/worktrees` call `allowFileRoot()` when they make a new location browsable.
- Allowed roots are stored slash-normalized, but that is a Set-key convention, not a correctness requirement: `isPathWithinRoots()` (`lib/path-security.ts`, the single implementation behind `isFilePathAllowed()`) re-resolves and case-folds both sides, so either path form authorizes correctly. Keep that one implementation — it is the security boundary.

### Plugins and skills
- `/api/plugins` uses pi's `SettingsManager` + `DefaultPackageManager` for global/project package install, remove, update, enable, and disable. Disabling writes empty `extensions/skills/prompts/themes` arrays for that package entry.
- `/api/skills` uses `DefaultResourceLoader` so settings paths, package skills, and project `.agents/skills` are listed the same way the runtime sees them.
- Skill toggling edits only the `disable-model-invocation` frontmatter key on the target `SKILL.md`; keep that surgical so user formatting survives. `PATCH /api/skills` authorizes by cwd (same as GET) plus exact `filePath` membership in `loadSkillsWithInstallInfo(cwd)`, not by resolving the skill file into extra allowed roots.
- `/api/skills/install` shells through `npx skills add ... --agent pi`; project installs run with the selected cwd.

### Built-in subagents
- The global `builtInEnabled` switch is persisted in `~/.pi/agent/agents/settings.json` and defaults to `true` when the file or field is absent. An explicit `false` disables it. Malformed settings fail closed; atomic updates preserve unknown fields. Concurrent sub-agent prompts are queued per parent session (`maxConcurrent`, default 10).
- The inline built-in extension factory is always present so reloading an existing wrapper can apply setting changes, but it registers no tools while disabled. After changing the switch, the user must explicitly reload the current session.
- When enabled, only a recognized legacy `pi-subagents` extension that registers any reserved tool (`Agent`, `get_subagent_result`, or `steer_subagent`) is removed. Unrelated extensions remain loaded, and resolved conflict diagnostics are discarded.
- Runtime `Agent` dispatch checks the setting again so a stale tool call cannot start a subagent after the feature is switched off.
- See `docs/adr/0003-built-in-subagent-toggle.md` for the precedence and persistence rationale.
- Agent profile files (`~/.pi/agent/agents/*.md`, project `.pi/agents/*.md`) may be shared with other runtimes. A save round-trips frontmatter keys this app does not own (`name`, `allowed_subagents`, `exclude_extensions`, `disallowed_tools`, `prompt_mode`, `isolation`, …) and carries `ext:` tool selectors through `tools:`.
- Managed keys are exactly `description`, `display_name`, `tools`, `load_skills`, `load_extensions`, `enabled`, `inherit_context`, `run_in_background`, `model`, `thinking`, `max_turns`. The `skills` / `extensions` aliases are seeded on first save and kept in step while they are booleans; a hand-authored whitelist such as `extensions: pi-advisor-flow` is never rewritten. The two flags fall back to those aliases when `load_skills` / `load_extensions` are absent.
- Profile precedence matches pi-subagents: project `.pi/agents` > workspace `.agents/agents` > global > built-in, and the top file wins whole — a disabled top file never falls back. The Agents UI lists one row per name; its switch targets the effective file (`setSubagentProfileEnabled`): disabling a built-in writes the `---\nenabled: false\n---` project stub, enabling a stub deletes it.
- `ext:` selectors in `tools:` are honored at spawn: they load only matching extension tools instead of every loaded extension tool.

### Auth and model config
- `ModelsConfig` combines models from `~/.pi/agent/models.json` with provider auth status from pi's `AuthStorage`/`ModelRegistry`.
- Provider listing is capability-driven, never id-driven: `lib/provider-listing.ts` decides membership from `auth.apiKey.login` / `auth.oauth` plus the stored credential type, so dual-auth providers (anthropic and github-copilot today — which providers declare both changes between SDK releases, so never assume it from an id) appear exactly once and never fall through both lists (#309). `lib/provider-listing-runtime.ts` adapts `ModelRuntime` to those pure helpers.
- auth.json holds **one** credential per provider and `ModelRuntime.logout()` deletes whichever it is. The delete routes therefore use `removeStoredCredentialIfType()` to compare and delete under the same file lock used by pi's auth storage. `ModelsConfig` also refreshes *both* provider lists after any auth change — refreshing one leaves a dual-auth provider rendered twice.
- OAuth/device-code/manual-code flows are streamed by `GET /api/auth/login/[provider]`; manual code responses POST back with a short-lived token stored in `globalThis.__piLoginCallbacks`.
- API-key routes store and remove keys through `AuthStorage`. Status endpoints must never return the raw key.
- The model test route is `app/api/models-config/test/route.ts`; `app/api/models/test/` is not a real route.

### Usage statistics
- `lib/usage-stats.ts` sums assistant `usage` per local day × hour × provider × model for every session file under `sessions/` (recursively: extensions nest subagent runs below a session directory), caching rows plus the header cwd in `~/.pi/agent/pi-web-usage-cache.json` keyed by `(size, mtimeMs)`. Cache entries outlive their files, and `commitSessionDeletes()` folds a file in before deleting it; every pi-web delete path (session, cascade, project) goes through it, so deleted sessions keep counting. v1 entries (no hour/cwd) stay visible until rescanned.
- Forks and context-inheriting subagents copy parent history; only messages at or after the file header's timestamp count.
- `GET /api/usage` starts an incremental scan, waits for its stat pass, then at most 1.5s more; a longer (cold/upgrade) scan returns the cached rows with `scan: { done, total }` and the page polls until it is null.
- Cost is repriced at current rates like tokscale: pi's `ModelRuntime` model cost (exact provider/model, then same id), then models.dev, then the recorded cost; otherwise the message is reported as unpriced. Flat rates, no long-context tiers. Model ids drop a router's `vendor/` prefix after pricing. The response is priced day × hour × model × project records; `lib/usage-view.ts` does all range/grouping/drill-down in the browser.

### Completion sound
- `hooks/useAudio.ts` stores the toggle in `localStorage` as `pi-sound-enabled` and reuses one `AudioContext`.
- Browser autoplay policy means sound must be unlocked from a user gesture; `ChatInput` calls the unlock hook from interactive controls, and `ChatWindow` plays the tone from `onAgentEnd`.

### Exported session HTML
- `/api/sessions/[id]/export` delegates to pi's export helper, then patches recursive tree helpers in the generated HTML to iterative versions so very deep linear sessions do not overflow the browser call stack.

### Typography
- One face everywhere: Sarasa Term SC, local install first, else the opt-in downloaded web font (`lib/sarasa-font.ts`). Do not add other families to `--font-sarasa-local`; mixed cuts made the UI differ per machine.
- Exactly two weights: 400 and 600. Only these have real faces, and `font-synthesis: none` is on, so any other weight either collapses to Regular or differs per machine.
- 600 is for headings only (dialog/panel/section titles including the sidebar's Projects/Explorer, markdown headings/`strong`/`th`). Never express selected, active, pressed, or clickable state with weight; use background, color, border, or an indicator bar. Buttons, inputs, list-item names, counts, badges, and small dim group labels stay 400.
- No italic in UI chrome: there is no italic face and synthesis is off, so CJK would stay upright anyway; mark states another way. Markdown `em` keeps `italic` and is upright unless a real italic face is installed.
- Three text tiers with the same contrast targets in both themes (on `--bg-panel`): `--text` >= 12:1 for content, `--text-muted` ~9:1 for headings/sidebar items/labels, `--text-dim` ~6:1 for metadata. The Claude dark palette is the one deliberate exception: its `--text-muted` follows Claude Desktop's measured ~11:1 secondary tier. Choose shades by these numbers; do not add ad-hoc grays, and do not permanently fade a tier with `opacity` (that is an unmeasured fourth gray). Opacity that toggles back to 1 for a state such as disabled/streaming is fine.
- Font sizes come from one scale. UI chrome uses four: 10 badges/tags/uppercase labels, 11 metadata (times, paths, process steps), 12 UI body and section headings (headings add 600, like the sidebar's Projects), 14 dialog/panel/detail titles. Reading content: 14 chat body, 13 dense content only (code blocks, file viewer, terminal, Mermaid source, markdown tables/file preview). Exceptions: 16 login input (iOS focus zoom) and device code, 20 glyphs (close ×, login brand). Chat-relative sizes use `calc(<11..14>px + var(--chat-font-size-offset, 0px))`. No half sizes; pick the tier by role.
- Icons are sized to the text they sit with: box = text size + 1 (11px text → 12, 12px → 13, 13px → 14), which puts a 24-unit icon's ink at CJK-glyph height. Icon-only buttons take the text tier of their bar (header, tab bar, sidebar, composer toolbar are 12px → 13). 10px is reserved for micro glyphs (chevrons, close ×); 16 only for text-less overlays/avatars. Stroke stays ~1.1px on screen: `strokeWidth = round(1.1 × grid / size, 1)` (24 grid: 12→2.2, 13→2, 14→1.9, 16→1.7; micro 3, or 1.3 on a 10 grid); sized icon components use `iconStroke(size)` (`components/iconStroke.ts`). Color: an icon takes the color and state of its row (render it with `currentColor` from the shared parent, no own tier, no `opacity` fade; this includes file-type icons, provider logos, menu items). When a row highlights one word to `--text` inside a muted row (process steps: tool name / Thinking), the icon stays at the row tier: line-drawn glyphs carry more ink than letters and read heavier at the same color. Align by ink, not by box: a glyph with a low mark (the terminal `>_` underscore) is drawn so its ink sits on the text baseline. Icon-only buttons rest at `--text-muted` and hover to `--text`, including close ×. Only disclosure chevrons may sit one tier lower (`--text-dim`). Accent/semantic colors mark state (selected check, error, info), never a resting icon. Center icon and text with flex `align-items: center`, no `translateY` nudges or `vertical-align: middle` (it sits on the x-height). Short state labels in the composer toolbar are lowercase ids (`medium`, `configured`, `chat-only`, `compact`).
- Enforced by `components/Typography.test.mjs`.

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

`entryIds[]` in `SessionContext` is a parallel array to `messages[]` — maps each displayed message back to its `.jsonl` entry id, used for fork and navigate_tree calls.

---

## CSS Variables (`app/globals.css`)

```
--bg --bg-panel --bg-hover --bg-selected --border
--text --text-muted --text-dim
--accent --user-bg --tool-bg
--font-mono
```
