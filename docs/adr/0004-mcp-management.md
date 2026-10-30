# 0004 — MCP management grafts pi's own MCP, it does not re-host it

## Status

Accepted and implemented. The items under "On demand" are not planned.

## Context

Pi Web exists to graft pi SDK/CLI capabilities onto a web UI. pi 1.4.0 already implements MCP
fully: stdio and streamable HTTP, OAuth (DCR, CIMD, loopback callback plus pasted redirect URL),
per-server `exposure` and per-tool `toolExposure`, resource tools, project overrides,
`auth.provider`, `mcp.log`, and `/mcp login|logout|reconnect` inside a session. What it does not
give a web UI: exports for the config editor, `McpServerConnection`, `signInMcpServer`, and any
status API; the running extension's state is closure-private.

Normal sessions load the SDK's `mcp`, `codemode`, and `tool-search` extensions exactly like the
CLI (`lib/builtin-extensions.ts`), with our safe `loadConfig` (bounded reader, trust,
`PI_WEB_PASSWORD` refusal) and a transport that scrubs the stdio environment.

agegr/pi-web (a reference fork) instead hands the SDK an empty `loadConfig` and re-hosts servers
through `pi.registerMcpServer()` from a 1.1k-line `McpHost` that infers status by patching
transport instances. That diverges from CLI semantics (servers become `extension` scope, name
precedence flips) and couples every SDK upgrade to reconstructed internals. We do not follow it.

## Decision

Keep the CLI-equivalent runtime: a session's MCP behaviour is the SDK extension's. Settings gains
capabilities by calling SDK modules server-side, outside any session, the way `pi mcp` does
(`dist/extensions/mcp/cli.js`).

### Measured: fan-out

A session's runtime starts as soon as its chat pane is visible (the SSE route calls
`startRpcSession`), and the MCP extension connects every enabled server on `session_start`.
With two `npx` filesystem servers in `mcp.json`, each runtime held 6 processes (`npm exec`, `sh`,
`node` per server) and about 500 MB RSS (sum, shared pages included); five viewed sessions held 30
processes and about 2.5 GB. Runtimes live 10 minutes after the last view. Browsing, not prompting,
pays this cost, so connecting is deferred to the first prompt or `/mcp` command (P3).

### Plan

P0 — backend corrections
- `/api/mcp` responses (every method, one serializer) carry env/header/`oauth.clientSecret` key
  names and value kinds (literal, `${VAR}`, `!command`), never values. URLs drop userinfo and the
  query; argument values after key/token/secret/password-like flags are masked. "Edit JSON" reads
  one raw entry through an explicit request.
- Saving a project entry with `auth` is refused (the loader rejects it; a scope move would
  otherwise delete the only usable copy).
- The check resolves the `auth.provider` token through a `ModelRegistry` over
  `createModelsConfigServices(cwd).modelRuntime`, only for such servers.
- The check accepts one server and reports per tool: name, first description line (type-checked),
  effective exposure, `readOnlyHint`/`destructiveHint`; plus resources, instructions, and the
  error (the SDK folds the stderr tail into it). It passes the SDK's `McpServerLog` like
  `pi mcp list`, and leaves `oauth.clientSecret` to the SDK's lazy resolution.

P1 — Settings capabilities
- OAuth sign-in without a session, request-bound SSE like `app/api/auth/login/[provider]`: open a
  connection, `getClient()` for `needs-auth` and the challenge, then `signInMcpServer` with
  `showAuthorizationUrl` → event and `promptForRedirectUrl(signal)` → the pasted URL or the
  loopback callback. One flow per credential identity (name + URL); the connection closes in
  `finally`. Sign-out deletes stored credentials (`McpOAuthCredentialStore.remove`), as
  `pi mcp logout`. OAuth servers waiting for sign-in in running sessions reconnect at their next
  turn (`reconnectSignedIn`); config changes still need the reload notice.
- Per-tool exposure: PATCH `toolExposure: { [tool]: exposure | null }`, `null` deleting the exact
  key. It edits where the switches edit (the project override when present). The SDK merges an
  override's `toolExposure` by replacing the whole map, so the first per-tool edit in an override
  seeds it from the global map.
- Per-server log: complete `mcp.log` records (continuation lines included) for `[name]`.
- UI: list → detail page (`SettingsLinkRow` / `SettingsDetailPage`). Detail: description,
  connection facts (names only), Test, sign-in, exposure plus per-tool table after a test, this
  project, log, Edit JSON, Delete. Warn when `autoEnableCodemode` is false.

P2 — Add by paste
- URL; command line; `pi mcp add …` (the SDK's `runMcpCommand(["add", …])` with a temporary `cwd`
  and agent dir, so `-l` cannot touch the project; succeed only when an entry was written);
  `claude mcp add …`; JSON (single entry, name map, `mcpServers`, VS Code `servers`).
- Preview: the command that will run, the variables it reads, `!command` values. Nothing connects
  before Save; Save checks that server once.

P3 — runtime
- Defer the `mcp` extension's `session_start` work to the first prompt or `/mcp` command.
- First prompt: with `direct` servers it waits for them to connect (up to 10 s, pi's startup wait) now that
  browsing no longer connects them. Stop during that wait ends the run before any request (the SDK
  aborts at `agent_start`), but the wait itself runs out first.

### On demand

- Subagent MCP: only once a concrete profile needs an MCP server directly. Each child run starts
  every stdio server again, which lazy connection cannot avoid (a child prompts at once). Then a
  minimal `mcp: on` profile key, preferably with a server selection to bound the processes.
- Not doing: a trust-dialog listing of `.pi/mcp.json` commands (trusting a project already trusts
  its `.pi/extensions`, which run arbitrary code earlier, so it moves no boundary); a Code mode
  settings page (codemode activates itself for `codemode` servers; `+codemode`, `codemode.mode`,
  and `inlineBudget` stay in `settings.json` as in the CLI); live per-session MCP status until pi
  offers a status API or event (Test in Settings and `/mcp` in a session cover it).

### Kept as is

- The read-only preset blocks every `mcp__*` tool call; pi's resource tools stay allowed
  (`lib/read-only-tool-guard.ts`). `readOnlyHint` is not trusted.
- Delete is a confirm, not a server-side undo store.
- `/mcp` stays a session command; its notices keep the "MCP settings" link.

### Not doing

agegr's host, status store, transport patching, durable sign-in registry, entropy-based secret
classifier, and 18-format importer; a null-prototype workaround for tools named like
`Object.prototype` members (the SDK runtime has the same lookup, so Settings would disagree with
it); harmonizing the working directory of `!command` resolution.

### Upstream requests

A status API or event for the MCP extension; exported config editor, `McpServerConnection`,
`signInMcpServer`; asynchronous `!command` resolution (`execSync` blocks the Next process);
abortable first-prompt wait; an own-property lookup in `getMcpToolExposure`.
