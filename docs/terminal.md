# Workspace Terminals

The Explorer terminal action opens or focuses a terminal for its selected cwd
in the right panel's existing tab bar. Each terminal tab keeps the cwd it was
created with. Files still mount only their active viewer; terminal panels stay
mounted behind inactive tabs, hidden panels, and session or project switches.

## Lifecycle

- Each new tab generates a random terminal ID before creation. Creation with
  the same ID and cwd is idempotent, including React Strict Mode's repeated
  effects. An existing ID cannot be reused for another cwd.
- `sessionStorage` retains terminal IDs, cwds, and the active terminal layout
  across refresh. Restored tabs first check the existing server instance and
  never silently start replacement processes after expiry or server restart.
- The shell is `$SHELL -l`; on Windows it is PowerShell as pi's powershell tool
  finds it (`getPowerShellConfig()`: pwsh 7, then Windows PowerShell), and
  `ComSpec` only without either. No setting: type `cmd` or `bash` in the tab.
- A new PTY gets a 120-second connection lease. Subscribing cancels expiry;
  the last subscriber leaving starts a new 120-second grace period. This also
  collects creations that never establish their initial connection.
- Hiding a panel, switching tabs, and unmounting a component only disconnect
  clients. Explicitly terminating a tab waits for creation and in-flight input
  before deleting the PTY. Restart waits for termination before creating a new
  ID. Failed termination leaves the tab available to retry.
- A shell exit closes the SSE stream and retains its output and exit code in
  the browser. Unobserved server records expire after the same grace period.
- On Unix, explicit termination and expiry signal the shell, escalating to SIGKILL after
  two seconds if it ignores SIGHUP. Server shutdown force-kills shells immediately.
  Windows always uses node-pty's no-argument `kill()` with no escalation timer:
  it already closes the console processes and rejects any signal (even asynchronously).

## Transport

Output events carry a monotonically increasing UTF-16 offset in SSE `id`.
Reconnections use `Last-Event-ID` (or `after` on an explicit reconnect) and send
only the missing suffix. The server keeps at most 128 KiB of UTF-16 code units;
an older cursor triggers a terminal reset and bounded history replay. This is
bounded output history, not a serialized full-screen terminal snapshot. Slow
SSE consumers are disconnected once their response queue fills.

Input and resizes are serialized. Pending adjacent input is batched so remote
connections do not require one round trip per keystroke; large pastes are split
without splitting Unicode characters. Failed input is not retried because its
delivery may be ambiguous. Reconnect attaches to the same process with a fresh
writer; restart explicitly replaces the process.

`bin/prepare-terminal.js` repairs node-pty 1.1.0's macOS spawn-helper executable
bits during installation, including published/npm-installed Pi Web packages.

Pi Web pins node-pty to `1.2.0-beta.15`, which includes Linux x64 and ARM64
prebuilt binaries. Native module loading is deferred until terminal creation,
so missing or incompatible binaries produce a JSON error with repair instructions.
Empty or non-JSON API errors show the HTTP status and direct users to the server log.

If a native binary cannot load, run
`npm rebuild node-pty --build-from-source --ignore-scripts=false --foreground-scripts` from the
installation directory (for npx, the cache directory containing `node_modules`).
On Debian/Ubuntu, install `python3` and `build-essential` first. This forces a
source build instead of reusing a missing or incompatible prebuilt binary.
Restart Pi Web after repair.

## Touch keys

A portrait touch screen (orientation from `screen.orientation`, never the viewport, which the soft keyboard reshapes) gets Termux's two key rows as the panel's last grid row, so xterm refits above them (`components/TerminalExtraKeys.tsx`, `lib/terminal-extra-keys.ts`). Keys go through `terminal.input(seq, true)` and follow xterm's application cursor mode; CTRL/ALT are one-shot and also modify the next soft-keyboard character. Buttons `preventDefault()` on pointer/mouse down so the keyboard stays up. Resizes clamp to at least 2 rows: the keyboard can fit the panel to one, and a rejected resize disables input.

## Terminal appearance

The terminal has no toolbar of its own. The selected terminal tab portals its
actions (light/dark, Reconnect on error, Restart) into the file panel's
workspace header, next to the tab bar, as the header's 30px borderless icon
buttons in app colors. A status dot (`--warning` connecting, `--danger`
error/exited) appears there only while the terminal is not ready; the full cwd
is the tab's tooltip. This holds on mobile too, where the panel is full screen.

The light/dark button switches only the terminal. Switching assigns
`terminal.options.theme` on the existing xterm; it does not recreate the terminal,
reconnect SSE, restart the shell, or discard output/scrollback. The mode is
independent of the app's light/dark mode, but surfaces follow the app palette
(`default`/`claude`): `TERMINAL_THEMES[palette][mode]`. The canvas is that
palette's `--bg` for the mode (so it joins the selected tab seamlessly when the
modes agree) and the touch-key bar its `--bg-panel`. Each mode keeps one ANSI
palette; Claude changes only the background. Terminal text, cursor and
selection never take the app accent: they only need to stay readable. The
cursor is a blinking 2px bar in the foreground color, also while unfocused;
programs such as vim still set their own shape.

`components/terminal-theme.ts` stores the boolean in `localStorage` as
`pi-web:terminal-light`. A window event synchronizes mounted panels, including
hidden tabs; the `storage` event synchronizes browser tabs and storage clearing.
A relevant storage event discards a failed write's stale page-local choice when
storage is readable. Fully blocked storage retains the current page's choice.
The terminal's
scoped CSS variables recolor the padding, viewport, errors and touch keys;
`--terminal-bg` must match the xterm background for each palette.

The light palette starts with the app's light semantic colors rather than the
upstream palette. ANSI white/bright-white become greys and yellows become ochres
so they remain visible on white. WCAG contrast ratios against `#ffffff`, measured
by `components/terminal-theme.test.mjs`:

| Color | Normal | Bright |
| --- | ---: | ---: |
| Black | 17.40 | 9.84 |
| Red | 4.83 | 6.47 |
| Green | 5.02 | 5.48 |
| Yellow | 5.02 | 7.09 |
| Blue | 5.17 | 6.70 |
| Magenta | 5.70 | 7.10 |
| Cyan | 5.36 | 7.27 |
| White | 6.54 | 4.74 |

On the Claude light canvas `#faf9f5` the minimum drops to **4.50:1**
(bright white) and **4.58:1** (red); the test covers both palettes.

Normal foreground is **17.40:1**; all 16 light ANSI text colors are **≥4.74:1**
(required ≥4.5 for 13px normal text, with no background-only color exceptions).
The dark ANSI palette is unchanged. Programs that
send explicit truecolor values or set their own backgrounds are not recolored by
the ANSI palette; xterm's `minimumContrastRatio: 4.5` adjusts such text at
render time so it stays readable on our backgrounds.

## Verification

Focused appearance/preference checks (no server needed):

```sh
node --experimental-strip-types --test components/terminal-theme.test.mjs components/TerminalPanel.test.mjs
```

Run `npm test` for native PTY, lease, output cursor, input queue, and storage
checks. `npm run test:terminal` starts an isolated development server and runs
desktop/mobile browser checks using generated session fixtures. Install the
Playwright Chromium browser first with `npx playwright install chromium`.
The browser check prints the temporary location of its screenshots and log.
