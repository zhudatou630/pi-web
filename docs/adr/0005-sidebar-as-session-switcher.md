# The sidebar is the session switcher (no chat tabs)

Status: accepted (UI redesign batch 4, `.pi/research/ui-redesign/IMPLEMENTATION-PLAN.md`).

Pi Web drops the chat tab strip. The sidebar row list (and on phones the drawer) is
the only way to pick a session; split view is opened from a row, and each pane gets
its own title bar. This ADR fixes the behavior that tabs used to define. Where it
says "today" it describes `components/ChatTabBar.tsx`, `lib/chat-tab-state.ts`,
`lib/chat-workspace-state.ts` and `docs/chat-tabs.md` at commit `12eebf67`.

## Model: two panes and a mount cache

The chat area holds at most two **panes**, `primary` (left, always present) and
`secondary` (right, only while split). A pane shows one **item**: a session
(`{ kind: "session", id }`) or the new-session page of one draft
(`{ kind: "draft", draftKey, cwd }`). One pane has focus; the sidebar, keyboard
shortcuts, notification clicks and links act on the focused pane. A session is
never shown in both panes: picking the session the other pane shows focuses that
pane instead. The same holds for a draft: the other pane already showing that cwd's
draft takes focus instead of a second copy.

There is no list of "open" sessions any more. What tabs gave besides navigation,
instant switching with the transcript and scroll position kept, comes from a
**mount cache** of `ChatWindow`s:

- The cache is an MRU list of session ids. Every session shown in a pane enters it
  at the front; switching away leaves it mounted and hidden (`display: none`, as
  hidden tabs are today).
- Kept mounted: the sessions shown in the panes, the **5** most recently shown
  hidden sessions, and every cached session that is running (agent running,
  subagents running, or waiting for a dialog). A running session is exempt from
  eviction until it settles; then it is an ordinary MRU entry and may be evicted on
  the next switch. Nothing is mounted that this page never showed.
- Eviction unmounts the `ChatWindow`. Coming back remounts it: the transcript loads
  again from the session file and the scroll position comes back from the existing
  per-session `sessionScrollPositionsRef` (already used for remounts).
- Upper bound: 2 shown + 5 hidden + the running ones. Today the number of mounted
  windows is unbounded (every tab stays mounted, no cap). Hidden idle windows hold
  no SSE (`useAgentSession` opens SSE for the visible pane, or while running), so
  the cost of a cached window is its React state and DOM.
- Drafts are not cached: a draft's text, quotes and images already live in the draft
  store (sessionStorage), so its new-session page is cheap to remount.

The cache is a pure module (`lib/chat-view-state.ts`, replacing
`lib/chat-tab-state.ts` and `lib/chat-workspace-state.ts`) so eviction is testable
without React.

### Server idle renewal

Today `useOpenSessionLeases` renews every session tab every 30 s
(`/api/agent/<id>/lease`), and an open SSE (`keepAlive: true`) holds the visible
runtime. The lease list becomes **the session ids in the mount cache**. Evicting a
session is the old "close tab": its runtime is no longer renewed and is disposed
after the idle timeout (10 min) unless it is running, and is recreated from the
file on the next visit. The server side does not change.

### Why keep running sessions mounted

Page notifications (completion, "needs your input") are raised by the mounted
`ChatWindow` (`onAgentEnd`, `onAttentionNeeded`). Today a running session in a
background tab still notifies; a running session nobody holds does not (Web Push
aside). Exempting running cached sessions keeps that behavior for every session
the user opened in this page.

## Single click, double click, preview

Preview tabs are gone, and with them pinning. A single click on a row shows that
session in the focused pane; the session that was there stays in the mount cache.
"Send keeps the tab" (`onKeepTabOpen`) has nothing left to do and is removed.
Middle click on a row opens it in split view (the mouse equivalent of the menu
item, desktop only; where splitting is not possible it does nothing); double click
is a plain click. The row's hover "open in new
tab" button is removed, leaving pin as the only hover action.

## Drafts and the new-session page

- "New session" (sidebar top row) and a project row's "+" show the new-session
  page in the focused pane, for the sidebar's selected cwd and for that project
  respectively, as today.
- There is **one draft per cwd** (project folder or worktree). Leaving a draft for
  a session parks its text under the cwd's parked key (`parkedNewSessionDraftKey`,
  the tab-less path that exists today); opening the new-session page for that cwd
  again brings it back. Changing the project or location on the page carries the
  draft along (as today).
- Drafts are never discarded by navigation, so the "discard unsent draft?" confirm
  goes away. A draft becomes a session in place when sent (same pane, same
  component identity, as today).
- What is lost: two unsent drafts in the same folder at once. A second "New
  session" in that folder shows the parked one.

## Split view

- Open: the row context menu item **Open in split view** (desktop, only while the
  chat area is wide enough to split: `CHAT_SPLIT_MIN_WIDTH`, 600px), and dragging a
  session row onto the right half of the chat area (a drop zone with a tinted
  right half appears while a row is dragged). The session opens in `secondary`,
  replacing what was there, and takes focus. The item is disabled for the session
  the primary pane shows; for the one the secondary pane already shows it only
  focuses.
- Each pane has its own title bar (the header row's segments, cut at the split
  ratio, now carry a title bar each instead of a tab strip): title, "project · branch ⌄", spacer, "Changes N", conditional
  tools (back to main, agents, branches), `⋯`, and × (close this pane). The file
  panel toggle is global and stays once, at the right end of the right pane's
  bar. The sidebar toggle leads the left pane's bar, as today. The
  unfocused pane's session tools stay inert until the pane takes focus (pointer
  down on the pane focuses it), as today: they act on the focused session.
- Close: × appears only while split, on both panes. Either one ends the split; the
  other pane becomes `primary`, keeps its component (no remount) and takes focus.
  The closed pane's session stays in the mount cache.
- Still at most two panes; still merged when the window gets too narrow (the
  focused pane stays); the split ratio, resize handle and keyboard resize stay.
- A sidebar click while split goes to the focused pane (today's "focused group").

## Keyboard

Global shortcuts, handled once in `AppShell`:

| Keys (macOS: Option) | Action |
| --- | --- |
| Alt+↓ / Alt+↑ | Next / previous session in the sidebar's displayed order |
| Alt+Shift+↓ / Alt+Shift+↑ | Next / previous session that needs you |
| Alt+K | Session switcher: focus the sidebar search |

- "Displayed order" is the sidebar rows as shown: PINNED, then the projects (or
  the status sections), skipping collapsed projects and rows behind "show more";
  while a search is shown, the result list. No wrap at the ends. If the current
  session is not in the list, Alt+↓ starts at the top. The session the other pane
  shows is skipped (picking it would only move focus).
- "Needs you" always uses the NEEDS YOU order of the status grouping (waiting and
  error first, then unread; newest first), computed from all sessions whatever the
  grouping, collapse state or search, and wraps. The other pane's session is
  skipped. Nothing to visit: no-op.
- The switcher reuses `SessionSearch`: Alt+K opens the sidebar (the drawer on
  phones with a hardware keyboard) and the search, focusing the field with its
  text selected. Enter in the field opens the first result; ↓ moves into the
  results. Esc behaves as today.
- All three open in the focused pane like a sidebar click.
- Ignored when: Ctrl or Meta is also down (Windows/Linux AltGr reports Ctrl+Alt),
  `isComposing` (IME), focus is in a terminal (`.xterm`, where Alt is the shell's
  Meta prefix), or a modal dialog is open (Settings › Models uses Alt+↑/↓ to
  reorder). Letters match `event.code` (`KeyK`), so layouts and Option-produced
  characters do not change the key.
- Discoverability: the search button's native `title` lists all three shortcuts;
  no shortcut sheet.

### Conflicts checked

From vendor documentation (checked 2026-11-27), not on real machines:

- **Chrome, Windows/Linux** (support.google.com/chrome/answer/157179): its Alt
  shortcuts are Alt+Home, Alt+←/→ (history), Alt+F and Alt+E (menu), Alt+D
  (address bar), Alt+Enter (address bar only), Alt+F4, Alt+Space, Alt+Shift+T/I/A/N.
  None uses ↑, ↓ or K. The keys the plan names as reserved (Ctrl+N/T/W/D/R/E/J/G,
  Ctrl+K "search from anywhere") are all Ctrl-based and unused here.
- **Chrome, macOS**: tab and focus shortcuts use ⌘+Option+arrows; none is
  Option-only. ⌘ is excluded by the Meta rule.
- **Safari, macOS** (Apple, "Keyboard shortcuts and gestures in Safari"): Option+arrow
  scrolls the page in larger increments. Overridden while Pi Web has focus; Page
  Up/Down and Space still scroll.
- **macOS text system** (Apple, "Mac keyboard shortcuts", support.apple.com/102650):
  Option+Shift+↑/↓ extends a selection to paragraph starts/ends; Option+↑/↓ moves
  the caret by paragraph; Option+K types "˚" on the US layout. In the composer
  these are taken over by the shortcuts. Accepted trade-off: Slack and Discord bind
  exactly Alt/Option+↑/↓ and Alt/Option+Shift+↑/↓ the same way, from the message
  field too; Cmd+↑/↓ still moves to the start/end of the text.
- **Windows**: Alt+Tab, Alt+F4, Alt+Space, Alt+Esc; Alt+Shift switches the input
  language only when released with no other key, so Alt+Shift+↓ does not trigger
  it (documented behavior, not verified here). AltGr is excluded.
- **Linux desktops**: GNOME binds Alt+Tab, Alt+`, Alt+Space, Alt+F1/F2/F4/F7/F8/F10;
  KDE Alt+Tab, Alt+F2/Alt+Space (KRunner), Alt+F3. None uses Alt+↑/↓ or Alt+K.
- **Firefox** (not a target, noted): Alt+letter opens menu-bar menus F, E, V, S, B,
  T, H; K is free.
- **In-app**: Alt+Enter (composer follow-up), Alt+←/→ (attachment order),
  terminal Alt, Settings › Models Alt+↑/↓ — none collides given the exclusions.

## Reload

- New sessionStorage key `pi-chat-view`, version 1: `{ primary, secondary,
  focusedPane, splitRatio }`, items as above (ids and draft keys only, no content,
  no catalog copies). The mount cache is not restored: after a reload only the
  shown panes mount; the cache refills as the user switches.
- Restore waits for the session list, as today. Deleted sessions are dropped; a
  missing primary with a present secondary becomes a single pane.
- A valid `?session=` wins: if a restored pane shows it, that pane takes focus;
  otherwise it replaces the restored focused pane. `?cwd=` starts a new draft and
  ignores the stored view (as today).
- The old `pi-chat-workspace` key is removed unread. sessionStorage is per browser
  tab, so it only matters for the first reload after the upgrade, where `?session=`
  still restores the focused session; only a split partner is lost, once.
- The old `pi-chat-draft-tabs` metadata: each listed draft that still has content
  is re-keyed to its cwd's parked key (first one per cwd wins; a later one in the
  same cwd stays in sessionStorage untouched), then the key is removed.

## Phones

The multi-tab strip under the top bar goes away; the drawer is the switcher. The
top bar stays as batch 3 left it (☰ with its dot, title, Changes N, `⋯`). No split,
so the long-press menu has no split item (the v5 mockup's "Open in new tab" is
dropped). The new-session page and drafts behave as on desktop.

## Effects on existing behavior

- **Favicon and app badge**: unchanged. They read the sidebar's markers, not tabs.
  The sessions that count as seen are the panes' sessions (`visibleSessionIds`), as
  today.
- **Notification click**: the service-worker path navigates to `/?session=<id>`
  (a reload, handled as a deep link below); the in-page fallback now calls the same
  open as a sidebar click (it pinned a tab before). Notifications for hidden
  sessions keep working as long as the session is mounted (see the running
  exemption).
- **`?session=`**: the URL always names the focused pane's session (bare path for a
  draft), via `router.replace` as today. Deep link: as in Reload above.
- **Fork** (row menu, `⋯` Fork session, message Fork): the new session replaces the
  source in the source's pane; the source stays in the mount cache. If focus moved
  while the fork was in flight, nothing switches (today's rule); the fork shows up
  in the sidebar either way.
- **Side chat**: opens in the other pane, splitting if needed (as today). When the
  chat area cannot split (narrow window, phone) it replaces the current session in
  place; the top bar's "back to main" returns.
- **Agents panel**: a row click switches in place (unchanged). "Open in new tab"
  and its middle click become **Open in split view** (hidden when splitting is not
  possible).
- **Session deleted**: a pane showing it closes (split) or shows the new-session
  page for the sidebar's cwd (single pane), as today.
- **Sidebar selection**: rows of both panes' sessions get the selected background.

## Desktop top bar

The bar takes the chat's `--bg` (it was `--bg-panel`), no bottom rule (design rule
2). It is the pane's title bar described under Split view; with one pane:
sidebar toggle (as today, always first), session title (12px `--text`, plain text
with the full title in `title`; "New session" on the new-session page),
"project · branch ⌄", spacer, "Changes N", conditional tools, `⋯`, file panel
toggle. Height stays `--workspace-header-height` (30px), shared with the sidebar's
top row and the file panel's tab row; design rule 4 says 34px, but the three rows
stay aligned and batch 3's sidebar row is final. Changing it later is one variable
for all three. The collapsed-title button that opened the
session panel when the sidebar was hidden goes away (the composer pill is that
panel's entry, `docs/ui.md`).

## Removed and kept

Removed: `components/ChatTabBar.tsx` (+ test) and its CSS, `lib/chat-tab-state.ts`
and `lib/chat-workspace-state.ts` (+ tests, replaced by `lib/chat-view-state.ts`),
tab handlers in `AppShell` (select/close/close-many/move/new tab/toggle split,
preview promotion, draft tab titles, `pi-chat-draft-tabs` writes), the mobile tab
strip, the row hover "open in new tab" button and its double/middle-click meaning,
`ChatWindow`'s `onKeepTabOpen`, the `chatTabs.*` strings that only tabs used.

Kept: one keyed `ChatWindow` list under one parent with grid placement (no
remount on split/merge/switch), split ratio and handle, draft store, per-session
scroll positions, leases (fed by the cache), `visibleSessionIds`, branch-cache
eviction, project-folder-missing and extension-shutdown behavior, file panel tabs.

`docs/chat-tabs.md` becomes `docs/session-switching.md` (panes, cache, keyboard,
reload; the file panel tab table and the other unchanged sections move with it);
`AGENTS.md` and `docs/ui.md` mentions of chat tabs follow.

## Tests

- `lib/chat-view-state.test.mjs`: MRU order, eviction at the cap, running and
  shown sessions never evicted, a settled session evicted on the next switch;
  showing a session already in the other pane focuses it; close-pane; next/previous
  in displayed order (ends, missing current); next needing you (order, wrap,
  none; other pane skipped); draft shown in the other pane focuses it;
  serialize/restore (deleted ids, `?session=` focus and replace, `?cwd=`), old
  `pi-chat-workspace` removed, `pi-chat-draft-tabs` re-keying.
- Shortcut matcher as a pure function: each binding, AltGr (Ctrl+Alt), Meta, IME,
  terminal target, modal open.
- Source/harness tests in `AppShell.*.test.mjs` and `SessionSidebar.test.mjs`
  rewritten for panes (no `ChatTabBar`), the split menu item, the drop zone, the
  per-pane title bar, leases from the cache, no mobile strip.
- Headless browser: switching keeps scroll and does not refetch (network log), split
  open/close (menu and drag), shortcuts, notification fallback click, `?session=`
  deep link, Fork, new-session page, reload restore; screenshots at 1440/820/390,
  light and dark.

## Decisions

The ten open choices were decided as follows (delegated review, 2026-11-27):

1. Hidden cache size 5.
2. Running sessions are exempt from eviction.
3. One draft per cwd, parked.
4. Fork replaces the source in its pane.
5. Both panes' rows are highlighted in the sidebar.
6. × on each pane while split; one file panel toggle at the far right (the v5
   mockup's left-pane toggle is not followed).
7. Alt+↑/↓, Alt+Shift+↑/↓, Alt+K.
8. Middle click opens in split; double click is a click.
9. `pi-chat-workspace` is dropped, not migrated.
10. The doc becomes `docs/session-switching.md`.
