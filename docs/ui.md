# UI conventions

Design notes moved out of AGENTS.md. Typography rules are enforced by `components/Typography.test.mjs`; modal rules by `components/ModalDialog.test.mjs`.

## Typography
- Three font roles, chosen by what the text *is*, not by which characters it contains:
  - **UI** `--font-ui` (Sarasa UI SC): all chrome — headings, labels, buttons, menus, tabs, sidebar and file-tree names, settings, stats labels *and* numbers, timestamps, counts, badges, status and error messages. Numbers that must line up use `font-variant-numeric: tabular-nums`, never mono.
  - **Prose** `--font-chat` (Sarasa UI SC today; future schemes may swap it for a serif/WenKai): user/assistant messages (final answers), compaction/custom/subagent markdown, the composer, read documents (markdown file preview). Never hardcode prose to `--font-ui`. The steps (process) list is UI throughout — thinking and intermediate assistant text included — so expanding it does not switch faces.
  - **Code** `--font-mono` (Sarasa Term SC): only (a) verbatim content — code blocks, inline code, terminal, file viewer, diffs, expanded tool args/output in chat (a collapsed step row's one-line preview — command, pattern, path — is a UI label), ASCII diagrams, system prompt, boxed verbatim values (device code, slash-command usage signature) — and (b) the bash-mode composer. Text fields and inputs are UI even when an identifier is typed (paths, URLs, model ids, headers, branch names): a mono face inside a UI-font box read as a mismatch. Identifiers shown as labels (and the trust-dialog cwd), list rows, descriptions, headers, or property values (package names, sources, paths, versions, branches, IDs, command names, file names) are UI: mixing mono into a UI line made rows look disordered. Any code face must keep CJK = exactly 2 Latin columns (Sarasa Term, LXGW WenKai Mono), so a Latin-only mono is not acceptable.
  - **Brand** `--font-brand` (Departure Mono, pi.dev's nav face, Latin only): only the sidebar's section titles (PINNED, PROJECTS, ARCHIVED, and the status grouping's NEEDS YOU, RUNNING, RECENT) and the footer's `SETTINGS` label, at 12px/400 uppercase with 0.08em tracking (the face's native 11px read lighter and smaller than the icons; 14px overpowered them). They show English in every locale (`sectionTitle()` reads the `en` package; the buttons' accessible names are translated). A section's count follows in UI type (`.sidebar-section-count`, `--text-dim`). Not for any other UI text; font schemes do not touch it.
- Font schemes (`hooks/useFontScheme.ts`, localStorage `pi-font-scheme`, applied pre-paint as `html[data-font]` by `app/layout.tsx`) only redefine `--font-ui` / `--font-chat` / `--font-mono` in `app/globals.css`; components never branch on the scheme. `sarasa` (default), `claude`, `wenkai`, and `system` exist today. `system` sets prose to `--font-ui-fallback` (Segoe UI + Microsoft YaHei, PingFang, Noto CJK): it deliberately renders per machine and downloads nothing, for users who prefer their OS fonts; exported images and HTML then also depend on the viewer's local fonts. `claude` only swaps prose to serif faces: Source Serif 4 (Latin-only variable subset, 400–600, no italic) in front of Noto Serif SC (variable 500–700, ~10.5 MB), mirroring claude.ai's serif Latin + Song CJK; CJK-shared punctuation goes to the Song face via `unicode-range`. Noto is declared as two `@font-face` rules on the same file, pinned at `font-weight: 500` and `700`: CSS 400 CJK prose matches the Medium face (Regular read too thin at 14px) and CSS 600 bold/headings match Bold, keeping the 200-unit body/bold gap; Source Serif keeps `400 600` (Latin 400/600). Components still use only 400/600. `wenkai` sets prose in LXGW WenKai (CJK and its own Latin in each face; curly quotes stay proportional). The family tops out at Medium and its Screen cut is already about Medium, so there is no real bold: CSS 400 matches WenKai Screen (~10 MB) and CSS 600 falls back to the original Regular (~8 MB, declared at `font-weight: 500`, fetched only when bold text shows), which the browser bolds. Bolding the thinner Regular keeps bold ~25% heavier than body instead of ~48%, so dense glyphs such as 鬱 clog less. Tuned for Chromium: Firefox synthesizes a much weaker bold (~10% more ink than body here), accepted because the user runs Chromium browsers. `html[data-font="wenkai"]` alone sets `font-synthesis: weight`: WenKai strokes are near-monoline, so uniform synthesized bold keeps its design; Sarasa has real 400/600 faces, so UI and code never synthesize. UI and code stay Sarasa. `@font-face` downloads lazily, so only the selected scheme's faces are fetched.
- All faces are the bundled web fonts in `public/fonts` (no `local()`, no opt-in): installed copies differed in cut/version per machine. Bump the `?v=` query when replacing a file, since `/fonts/*` is served `immutable`. Only Simplified Chinese and English are supported (no zh-TW locale).
- Exactly two weights: 400 and 600. Only these have real faces, and `font-synthesis: none` is on (except the `wenkai` scheme, whose only face has no bold; see above), so any other weight either collapses to Regular or differs per machine.
- 600 is for headings only (dialog/panel/section titles, markdown headings/`strong`/`th`). Never express selected, active, pressed, or clickable state with weight; use background, color, border, or an indicator bar. Buttons, inputs, list-item names, counts, badges, and small dim group labels stay 400.
- Text that clips (`overflow: hidden` / ellipsis) needs `line-height` >= 1.3: Sarasa UI descenders reach ~0.24em, so a `line-height: 1` box cuts g/y and the bottom of CJK.
- No italic in UI chrome: there is no italic face and synthesis is off, so CJK would stay upright anyway; mark states another way. Markdown `em` keeps `italic` and is upright unless a real italic face is installed.
- Three text tiers with the same contrast targets in both themes (on `--bg-panel`): `--text` >= 12:1 for content, `--text-muted` ~9:1 for headings/sidebar items/labels, `--text-dim` ~6:1 for metadata. Choose shades by these numbers; do not add ad-hoc grays, and do not permanently fade a tier with `opacity` (that is an unmeasured fourth gray). Opacity that toggles back to 1 for a state such as disabled/streaming is fine.
- Font sizes come from one scale. UI chrome uses four: 10 badges/tags/uppercase labels, 11 metadata (times, paths, process steps), 12 UI body and section headings (headings add 600), 14 dialog/panel/detail titles. The settings dialog is a form surface one tier up: 14 labels/nav, 13 descriptions/controls/tables, 16 group and detail titles, `--ui-row-height` controls, 15px nav icons. Reading content: 14 chat body, 13 dense content only (code blocks, file viewer, terminal, Mermaid source, markdown tables/file preview). Exceptions: 16 login input (iOS focus zoom) and device code, 20 glyphs (close ×, login brand). Chat-relative sizes use `calc(<11..14>px + var(--chat-font-size-offset, 0px))`. No half sizes; pick the tier by role.
- Icons are sized to the text they sit with: box = text size + 1 (11px text → 12, 12px → 13, 13px → 14), which puts a 24-unit icon's ink at CJK-glyph height. Icon-only buttons take the text tier of their bar (header, tab bar, sidebar, composer toolbar are 12px → 13). 10px is reserved for micro glyphs (chevrons, close ×); 16 only for text-less overlays/avatars. Stroke stays ~1.1px on screen: `strokeWidth = round(1.1 × grid / size, 1)` (24 grid: 12→2.2, 13→2, 14→1.9, 16→1.7; micro 3, or 1.3 on a 10 grid); sized icon components use `iconStroke(size)` (`components/iconStroke.ts`). Color: an icon takes the color and state of its row (render it with `currentColor` from the shared parent, no own tier, no `opacity` fade; this includes file-type icons, provider logos, menu items). When a row highlights one word to `--text` inside a muted row (process steps: tool name / Thinking), the icon stays at the row tier: line-drawn glyphs carry more ink than letters and read heavier at the same color. Align by ink, not by box: a glyph with a low mark (the terminal `>_` underscore) is drawn so its ink sits on the text baseline. Icon-only buttons rest at `--text-muted` and hover to `--text`, including close ×. Only disclosure chevrons may sit one tier lower (`--text-dim`). Accent/semantic colors mark state (selected check, error, info), never a resting icon. Center icon and text with flex `align-items: center`, no ad-hoc `translateY` nudges or `vertical-align: middle` (it sits on the x-height). The one measured exception: Sarasa UI inks 11px text ~0.9px above its line-box centre, so icons in 11px metadata rows (answer footer, message actions) take the shared `.meta-row-icon` / `.message-action-button svg` lift in `app/globals.css`. State dots (below) are not icons and take none of these size rules. Short state labels in the composer toolbar are lowercase ids (`medium`, `configured`, `chat-only`, `compact`).
- Enforced by `components/Typography.test.mjs`.

## Sidebar top row and grouping
- The sidebar starts with one row as tall as a section header (and the chat's top bar): "+ New session" fills it (the + in the folder icons' slot), then two 26px icon buttons, search and "Group and filter". New session opens a draft at the sidebar's selected cwd (no project yet: the folder picker); the project row's hover + stays for a specific project. There is no PROJECTS header toolbar.
- "Group and filter" menu: a "Group" caption with By project / By status (trailing check), | Show archived (check, count as meta, disabled at 0), | Collapse all (by project only, enabled while a listed project is expanded), Mark all as read (enabled while anything is unread or failed). The grouping is remembered per device (`localStorage` `pi-web:sidebar-grouping`, `lib/sidebar-grouping.ts`).
- Mark all as read takes each row's Mark as read path for every family with an unread member or an unseen error: marks clear at once, and the following status polls write the shared `readAt` (ten ids per poll, `/api/agent/running`) up to at least each error's time, so errors clear too.
- By status: PINNED stays first; then NEEDS YOU (waiting and error first, then unread; each newest first), RUNNING (running, or idle with running subagents), RECENT (the rest, newest first, with the same show-more paging as a project). Empty sections are not shown. Every project is listed, single-project mode included; a row of another project than the selected one puts the project's name before its time (`pi-bot · 3m`). Waiting and error rows keep their word.
- What by status leaves to by project: project rows and their menu (Show in Files, rename, move, select sessions, archive older), project drag, Collapse all, single-project switching (its project row opens the switcher). The archive always lists by project. Search works in both.
- Project rows: folder, name, the folded state dot, and one hover action, + (New session in this project). Show in Files is in the project's context menu. Worktrees are switched, created and removed on the new-session page and in the Files view, not on the project row.

## New-session page
- An empty draft shows only the composer, with two text menus above it at its left edge (ChatInput's `attention` slot): the project ("pi-web ⌄": every listed project, then Open folder…, which also lists that folder as a project) and where it runs ("Project folder · main ⌄" for the main checkout, the branch glyph and branch for a linked worktree). The second menu: Project folder with its branch, then "Existing worktrees" (each with a remove action; a dirty checkout asks for a forced removal), then New worktree…, whose branch field says "From <main checkout branch>". Above them the Pi Web wordmark, then the app update notice when there is one; no tagline or example prompts.
- The page shows no file panel: entering it folds an open panel and leaving it reopens it; opening the panel on the page keeps it open afterwards.

## Session state: one dot, one word
- A session has at most one state, shown as an 8px CSS dot (`SessionStatusDot`, `.session-status-dot` in `app/globals.css`), never an SVG badge or a count. Running (including a main session idle while its subagents run) is `--text-dim` and breathes (opacity 1 ↔ 0.35, 1.6s; still under `prefers-reduced-motion`); unread is `--accent`; waiting for input is `--warning`; error is `--danger`. The four stay apart in both themes and with motion reduced (gray/blue/amber/red; only running moves).
- Precedence, for a row and for a folded group alike (`lib/session-status.ts`): waiting = error > unread > running. A folded project (or the folded PINNED section, or the other-projects summary) shows only its most urgent dot, no counts; standing glyphs (cache keepalive, scheduled routines) are not states and stay.
- The row's dot sits in the leading slot left of the title (the project folders' column), so titles never shift. Waiting and error rows also replace the relative time with an 11px word in the same color ("Waiting", "Error"); running and unread keep the time. The row's native `title` adds the reason ("Waiting: <dialog title>", "Error: <provider message>"), and the row's context menu (right-click, long press) starts with the session title and the same reason; the pressed row keeps a hover tint while its menu is open. Reasons are one line, at most 120 characters, and reach the browser only through the status poll and session list (behind the web password when one is set).
- Pin is a hover action (with open-in-new-tab), and in the context menu on touch; pinned sessions are already in PINNED, so the row carries no pin mark. A linked worktree is a 12px branch glyph after the title (branch and path in its `title`), no branch text, so titles keep their width.
- Error: the session's last message is an assistant reply with `stopReason: "error"`, i.e. pi gave up after its automatic retries. The session scanner (`lib/session-list-scanner.ts`) derives it from the file, so it survives runtime disposal and server restarts; any later message (a retry that succeeded, a new prompt, a `!` command) clears it, and a Stop (`aborted`) never sets it. pi omits each failed attempt it retries (a `context_edit` with `replacement: null`); an omitted failure is cleared too, so a Stop during a retry's wait is not an error. Its time is when the failure entry was written (the reply's own `timestamp` is its request start). Like unread it is a "you have not seen this" mark: hidden while the session runs or is on screen, and cleared by the shared `readAt` (attention on the visible pane, or Mark as read). It keeps a family out of "show more" and out of archive-older, like running and unread. Subagents, side chats and routine-only runs stay silent, as they do for unread. Mark as read targets at least the error's time and stays applied locally until the shared read reaches it. Errors count toward the favicon and the installed app badge (`lib/favicon-badge.ts`): the count covers waiting, error and unread sessions (a failed run that is also unread counts once), and the color is the most urgent kind — amber while anything waits, red while an unseen error remains, green for unread only.
- One state appears once per screen: the dot lives on the sidebar row (and on chat tabs while they exist). The conversation does not repeat it; inside a turn, only the live process row carries the running dot.
- What needs you sits above the composer, at its width (ChatInput's `attention` slot): a pending extension dialog, and after a run that ended in an error (the same test as the error state, not cleared by reading) one line "Error · reason · View output". The reason is the session list's `lastError.message` (the failed reply's own message while the list catches up). View output scrolls to the reply's error card and opens it, unfolding its process group if needed. There is no retry button; the existing Continue under the error card stays.

## Color budget
- Color is for things that need you (waiting, error), unread, and diffs (+/− and the Changes view's status letters). Everything else uses the three text tiers: process rows, the answer footer, file-tree status letters and folder change dots (`--text-dim`), the current project's folder (no tint), unsent-draft marks.
- Process steps keep their tool icon (Thinking, tool, subagent, error) before action, object and time. Row actions (copy command, open file) appear on hover or focus with a fine pointer, always on touch.
- The answer footer shows model, duration (hourglass), `TTFT` (gauge) and end time (clock), each with its 12px icon. Copy and export appear on hover (always on touch).

## Top bar context
- Desktop top bar, after the chat tabs: "project · branch ⌄" in 11px `--text-dim` text (a branch glyph marks a linked worktree). Its menu: Open in terminal, Show in Files (the file panel's Files view at that cwd), Copy path. Then, before the conditional tools, "Changes N": the active session cwd's uncommitted file count (`/api/git/status?lines=0`, which skips line statistics), hidden at 0, opening the file panel on Changes · All uncommitted (phones too). It refreshes on the explorer's existing triggers (run end, writes, focus), never on its own timer. Each split pane's header has its own. Unsplit, Split right (⊞, VS Code's editor action) follows Changes N, before the conditional tools; chat tab behavior is in `docs/chat-tabs.md`.
- The chat top bar has no bottom rule: its `--bg-panel` against the chat's `--bg` is the edge, and the visible chat tab (`--bg`) joins its pane; inactive tabs carry no rule either. The sidebar has no right rule for the same reason. Rules stay on the file panel (its left edge, the tab row's bottom), the composer and cards.
- While a run streams, the composer's placeholder says Enter interjects (steers the current turn). The composer toolbar's readouts are unchanged.

## Borders: one closed border per line of sight
- Looking from the canvas inward, at most one closed border (four-sided `border`, or a full `box-shadow` 1px ring) is crossed. Stacked frames read heavy and fragment the page.
- Only self-contained objects get the frame: the composer, dialogs, menus/popovers, standalone code blocks and tables, cards.
- Everything inside a framed object is borderless: toolbar buttons and chips are ghost (transparent, hover fill) or a quiet `--ui-chip-bg` tint, nested regions use a tint. Internal divisions are single-side rules (`border-top`/`border-bottom`), never a smaller box.
- Exempt: an image's own edge (a faint ring over the pixels, e.g. `.image-thumb::after`, so white screenshots keep their shape), focus rings, drag/drop indicators, form controls (checkbox, radio, switch; text fields and secondary/danger buttons, which are the floating-surface color with a hairline `--ui-field-edge`, as in Claude's forms: a neutral tinted fill read muddy on the warm palette), and floating layers (menus, popovers, dialogs, tooltips), which start their own count.

## Menus
- Quiet surface, clear rows (after Claude Desktop): `.menu-surface` is the only frame (10px radius, 4px padding); rows are `--ui-row-height` (26px, the same height as list rows, text buttons and single-line fields) of 12px text with 13px icons and a 6px radius (13px text read too large next to the 12px chrome; 24px felt cramped, 28px loose). Groups get their air from the dividers, not from taller rows.
- One clear surface: menus, popovers and dialogs sit on `--bg-elevated` (white in the default light palette, `#262626` in default dark, the soft paper `#fdfcfa` in Claude light, `#252524` in Claude dark), whatever area they open over; the settings dialog's nav, the tool-definitions list and embedded pages paint nothing of their own, and dialog headers are unruled. Shadows are light and short (`--ui-shadow-popover`/`-dialog`): the hairline border draws the edge, the shadow only lifts; they never borrow the canvas or sidebar tone. Anything painted inside them (sticky heads) uses `--bg-elevated` too.
- Floating lists follow the same rules: the Agents panel, tab list, branch tree and autocomplete popovers have no per-row rules or resting tints, the current item is a trailing check, and a row action (close, remove) is a `.menu-surface-row-action`. Outlines (minimap, mobile outline) have no checks, so the reading position keeps a plain tint.
- Two text tiers inside a menu: every label is `--text`; everything secondary (captions, meta, values, chevrons, the back row) is `--text-dim`. State never changes the text color: hover and keyboard tint the row, the check marks the choice, only `.is-danger` is colored.
- Row anatomy: optional `.menu-surface-label` group caption, then `[icon] label [dim meta] [trailing slot]`. The trailing slot means one thing per kind: `<MenuCheck>` (accent ✓) = current choice, a value + chevron = submenu, a row action (remove) = shown on hover, always on touch.
- One left edge: captions, options and actions start at the same x. No leading check gutter; the check is trailing. A leading icon is only for identity (a computer, a folder, a provider) and only when every row in the list has one; an action row then takes a matching icon (+), otherwise it is text like the rest ("Custom path…", "New worktree…").
- Action menus (context menus, ⋯) are text only: verb icons add noise without telling rows apart. Order rows by intent and split the groups with dividers (open | edit/state | archive/delete). Destructive items sit last and are `--danger` at rest (`.is-danger`).
- Selection is the check alone, in every menu: only the row under the pointer or keyboard is tinted, so a checked row and a hovered row never stack into two tiles. Check-less pickers (TimePicker) tint the picked value instead. The highlight leaves with the pointer: list-driven menus (`Select`, `ModelSelector`) clear their active row on `mouseleave`, and a click opens with nothing highlighted (keyboard opening starts on the current value). A row with its own action (worktree remove) is one hover unit; the action stays inside the tint.
- Options and actions ("New worktree…", "Open folder…") are split by an inset `.menu-surface-divider`, not by a border on the action row.

## Motion
- Durations are tokens: `--motion-fast` (120ms: hover, color, press, menus), `--motion-base` (200ms: panels, reveals), `--motion-slow` (300ms: wide color fades). Moving things use `--ease-out`; color fades keep the default `ease`. Loops, delays and reduced-motion zeros stay literal; a deliberate one-off carries a `motion-exempt` comment. Enforced by `components/Motion.test.mjs`.

## Selection toolbar
- The chat's "Quote / Side chat" and the file viewer's "Quote" share `lib/selection-toolbar.ts`: anchored to where the selection starts (centered on its first line), above that line, flipping below the last line only when there is no room. Touch prefers below (the system copy menu sits above). The chat toolbar follows its text on scroll, hides when the text leaves view, and its inline composer grows away from the text. Buttons that cannot act are disabled, not removed, so the toolbar never changes width.
- Chat selection state belongs to `QuoteSelectionPopover`, not the transcript. Keep mounted history laid out: stale intrinsic heights after a column resize make scroll restoration, search and outline offsets unreliable even with the 50-row window.

## Modal dialogs and confirms
- Modal shells (Settings, its nested dialogs, info, trust, directory picker, agent import, image generation) render through `components/ModalDialog.tsx`: the `<dialog>` element is the full-viewport scrim (the caller's backdrop class), its children are the surface. Layering is the browser's top layer, so no z-index; the latest `showModal()` is on top and everything else is inert.
- Escape belongs to the topmost dialog: `ModalDialog` handles it on keydown (preventDefault + stopPropagation, so an outer dialog stays open) unless a nested control already prevented it (a select menu, a rename field). Pass no `onClose` while the dialog must stay open (busy); if the browser still closes it, it is reopened.
- Android's system Back is a close request on the topmost `<dialog>` (Chromium's CloseWatcher), so it reaches `onClose` with no history entries of ours. Settings on a phone passes its header Back there, so Back goes up a level (detail → section → list) before it closes. A repeated Back without a tap in between gets an uncancelable `cancel` and then closes natively: `ModalDialog` answers only the `close` (one `onClose`, not two), reopening the dialog first so an owner that stays open (or opens a discard confirm on top) keeps it. Browsers without CloseWatcher (Firefox) still navigate away.
- Dialog anatomy (after Claude): `--ui-radius-xl` (14px) surface, 20px inset; a 14px/600 title, a quieter `--text-dim` line under it, the content, then the actions bottom-right. No header or footer rules. Cancel is a hairline `secondary` button (never ghost), the confirm button is `primary`, or filled `destructive` red for a destructive action, and is labeled with its verb ("Discard", "Delete", "Disconnect"), not OK.
- Confirmations use `useConfirm()` (`hooks/useConfirm.ts`): resolves a boolean; the message's first line is the title, further lines the detail (`"Discard unsaved changes?\nYour changes…"`). `{ danger: true }` starts on Cancel and fills the confirm red, `confirmLabel`/`cancelLabel` name the actions ("Keep editing" for a discard), `{ alert: true }` shows the confirm button only. `window.confirm`/`window.alert` are banned (guarded by `components/ModalDialog.test.mjs`). In-place confirms anchored to a context menu (delete project/session/file, force-remove worktree) stay as popovers with the same pair: hairline Cancel, then the filled action (`.is-danger` red, `.is-primary` for archive).
- Pane-scoped extension UI (`ExtensionDialog`, custom panels) is deliberately not modal: it can be collapsed while the chat stays usable. `ExtensionDialog` docks above the composer at its width (ChatInput's `attention` slot), a `--ui-radius-lg` card with a 14px/600 title, capped at `min(50dvh, 460px)`; collapse, countdown, keyboard and Esc cancel are unchanged; the footer says how to answer ("Click an option to submit · Esc cancels"). Custom panels (`custom()`, terminal-like) still float over the transcript.

## Settings copy

Design carries the meaning; the page does not explain itself. Visible text is limited to labels, values and units, empty states, and missing/failed states with their next step (one sentence). Scope, side effects, file names (`settings.json`, `mcp.json`, …) and implementation notes stay out of the UI, with no help icon: they belong in these docs. Consequences that lose data go in the confirm dialog, only when they apply (e.g. deleting a project copy of an agent). Format rules appear only as the error for an invalid value; field guidance is a placeholder or an example value.

Global vs project uses one pattern (`components/SettingsScope.tsx`): the global row is "On by default"; the project row is labelled with the project name (full path in `title`). An inherited row shows nothing extra; an override shows the "This project" status plus the ↺ reset button, both before the switch so switches stay in one column.

`components/SettingsCopyRules.test.mjs` enforces the rest: no authored `description={t(...)}` on settings rows, settings strings at most 80 characters and free of file names, confirm dialogs excepted. Check desktop and 390 px widths in both English and Chinese after copy or layout changes.

## Top bar and composer panels
- One panel at a time (`activeTopPanel` in `AppShell`), always a `popover-surface` card that sits next to its trigger: top-bar triggers (agents, branches, mobile outline) open downward under the bar, the composer's context pill (`session`, the only entry to usage/cost/session info on every platform) opens upward, docked to `.chat-input-composer` (right edges aligned, never wider than the box). Phones use the same cards, inset 8px; there is no full-width sheet.
- Top-bar order is the same on both platforms: "Changes N", conditional tools (back to parent, agents, branches), then the fixed ones at the right end: `⋯` menu, and on desktop the file panel toggle. Conditional tools grow leftwards so the fixed ones never move.
- Phones show four things: ☰ (a 6px `--warning` dot at its top right while any session waits for input or has an unseen error, `hasBlockedSession()`), the session title (12px `--text`), "Changes N", `⋯`; conditional tools appear before `⋯` only when needed. The `⋯` menu starts with Outline (the `#` outline sheet; desktop has `ChatMinimap`) and Files (the file panel's Files view at the session's cwd), the way to the panel when Changes N is hidden.
- The pill shows ring + tokens + cache + cost on desktop; phones show ring + tokens only (cost and cache are in the panel). It stays rendered when the reading is unknown (after compaction) because it is the only way to the panel. Its pressed state comes from `activeTopPanel` (`sessionStatsOpen`), never from local state.
- Panel content is one column: heading rows carry their key figures (Context window: used / size · free, percent), rules are only between the three sections and above the Total number cells. Text has two tiers: headings and values `--text`, labels `--text-dim`; only the percentage takes a state color.
- The Context window meter is one color; its composition is a column-major 2×2 under it: fixed overhead left (System prompt incl. context files and skills, Tools), what grows with work right (Conversation, Tool results). All four always render so the grid never reflows; unknown parts (no recorded system message) show `—`. Shades of one color on the meter were tried and dropped: adjacent shades were too close to read and looked like rendering noise. `lib/context-breakdown.ts` replays the transcript's system messages and estimates chars/4; the client scales the parts to the reported tokens, prefixing `~` when there is none. Fetched only while the panel is open (`/api/sessions/[id]/context-breakdown`, file results cached by mtime/size). The meter is a canvas (`components/ContextMeter.tsx`) drawn in device pixels, because a CSS mask cannot keep 3px cells and 1px gaps even at fractional scales. System/Instructions/Tools rows open the existing system prompt and tool dialogs.
- After editing `app/globals.css`, check the served chunk really has the new rule (see the Images dev note): a stale CSS chunk renames classes without their rules and breaks grid layouts.

## Prompt delivery and compaction

- A transport failure is not a rejection: once a normal prompt is confirmed idle, compare new persisted user entry ids with the pre-send history. If delivery cannot be confirmed, return text and images through the original tab's draft restore path and show a warning; never automatically resend. Steer/follow-up failures return immediately with the same warning.
- A built-in command lock restores only the textarea focus it displaced, after the fieldset is enabled; unchanged text also restores its selection. Pointer interaction elsewhere, Tab, moved focus, an open dialog or an unmounted editor cancels restoration. This is not mobile autofocus. Compaction history refreshes in the background so a newly typed draft and its selection stay mounted.
- `/compact` starts the existing compaction action without holding the composer's command lock. Keep typing, the queued rows and Recall usable. The composer adds no status UI for it: only the placeholder says messages will queue; Stop compaction stays in the controls menu; the result and errors use the existing feedback row. While a run is live its process row already reads "compacting"; an idle manual compaction shows that same live row (pulse, elapsed, label) on its own at the end of the transcript.
- On the SDK's explicit manual-compaction refusal, the session wrapper parks prompts (including images) in admission order; a parked plain prompt is listed as a follow-up (it runs after the compaction), an explicit steer stays a steer. Queue state is shared across tabs and survives a browser reload, not a server restart. Successful, failed and aborted compactions flush through the same admission chain; automatic compaction keeps using the SDK's streaming queues.
- Stop compaction only stops summarization: parked prompts still run, as in pi's TUI. Ordinary Stop snapshots and clears SDK delivery queues and returns them with parked prompts to the sending composer's draft before aborting; queued extension messages remain custom history without triggering another run (see `docs/extensions.md`), but dropped subagent reports stay unread in their wave (see `docs/subagents.md`). With no queued prompts neither action starts a run. Recall reads SDK delivery queues before clearing them, so image recovery remains fail-closed.

## Streaming code fences

While streaming, only an unambiguous top-level plain fence skips react-markdown
(`parseStreamingFence`). Math, Mermaid, SVG, indented fences, CR line endings,
info escapes/entities and trailing prose keep the original parser. Finished
messages always return to the normal whole-message parse and deferred highlighting.
The same CodeBlock owns both boxes, typography and horizontal scrolling. Its streaming code
is cut into 64-line pieces: completed pieces are memoized and use
`content-visibility:auto`; only the tail changes. Piece scanning resumes at the
new suffix (and resets after a rewrite), rather than splitting every old line on
every chunk. The block boundary supplies the inter-piece newline; copy uses the
original code. Existing markdown normalization/block detection still scan the
message; this change removes repeated Markdown parsing and full-pre layout, not
all per-chunk string work.

## PlantUML fences

In chat and Markdown file previews, `plantuml` and `puml` fences show normal
code with **Render on plantuml.com** once there is source to render. The action
is disabled while streaming. Clicking sends that exact source in an SVG image
URL to `https://www.plantuml.com`, with no referrer; edits require a new click.
The browser uses raw deflate and PlantUML's alphabet, or UTF-8 hex if raw deflate
is unavailable. URLs over 6,000 characters are refused locally. The diagram uses
the shared image viewer; **Source** returns to the code and lets you retry.
The app page has no `img-src` restriction; sandboxed file responses are unchanged.

## Extension terminal text

Plain-text cleaning and ANSI rendering both remove pi-tui APC cursor/fake-cursor
markers before rendering. Markers cannot span CR/LF: a truncated marker must not
consume later body text. Empty custom-panel normalization also cleans its fallback.

`AnsiText` renders the 16 ANSI palette slots (including indexed 0–15) as CSS
classes. Semantic red/blue/yellow and unbacked neutral text inherit the app palette;
other hues use our terminal's light/dark colors. Neutral backgrounds have separate
terminal black/white slots; neutral foregrounds on those backgrounds use terminal
neutrals too, including a contrasting default when no foreground was specified.
This keeps white-on-black and black-on-white readable in either app theme.
Explicit 256/24-bit colors stay exact. Keep `WebExtensionTheme`: it already emits
theme-independent ANSI slots.
pi's `generateSystemThemeColors({})` also yields palette slots, but importing its
private SDK module and asynchronously replacing the theme adds no needed behavior
here. `custom()` stays `PlainTextTheme`, widgets remain no-op. Dialog display
text, editor prefill/placeholder, title, inserted editor text, collapsed summaries
and notices strip ANSI. Select replies retain the original option value.

## Pending edit previews

Expanded edit calls with complete SDK-shaped arguments and no result show their
old/new text through the normal paired diff renderer, without file line numbers.
Edits are separate hunks, capped at 1000 rows and 4000 UTF-16 units per line.
Results (including errors) replace the preview. Aborted/failed assistant calls
never execute: ChatWindow carries that fact from the original message even when
partitioning moves its terminal notice to the answer. No file reads or speculative
application are involved; unlike the TUI, this is an argument-only preview.

## Tool summaries and notice links

Collapsed tool headers prefer command, pattern/query, then path (with the existing
path metadata); otherwise they show primitive arguments or bounded nested text,
never object coercion. Argv commands join with spaces. Notice HTTP(S) links stop
at sentence/full-width punctuation and retain balanced parentheses and IPv6 hosts;
only their host is displayed, while the full URL stays in href/title.

## Chat turn grouping

`getMessageGroupBoundaries()` is shared by chat rendering, turn activity/file
summaries, live-tail detection and history pagination. User messages, visible
compaction summaries and the two subagent notices keep their fixed boundaries;
subagent notices remain in process details, not visible anchors. Other custom /
`!` stretches after an assistant ending in `stop` or `aborted` open a new turn
only when followed by another assistant (or at a running agent's tail).
`length` / `error` continuations stay in the same logical prompt.

The last visible custom anchors an inferred turn; otherwise the last hidden
custom is boundary-only, with no rendered row or scroll ref. Shell cards stay
outside the process fold even between anchor and answer. Timing starts at the
stretch's last custom, not its visible anchor, and uses the existing timestamps
and `completedAt`. Pagination keeps the preceding assistant as inference evidence,
subject to the existing 1000-entry extension cap. This is an ordering heuristic:
pi does not persist `triggerTurn`. The user-prompt minimap is unchanged.

## Stopped replies

Only a settled assistant `stopReason: "aborted"` gets the translated Stopped mark,
first in `data-answer-footer` (11px, dim, regular). Its provider error text is not a
stop reason. `partitionAssistantMessage()` keeps an answer even before the first
token or during tool arguments, and removes the process copy's abort metadata,
so grouped replies say it once outside the process details. Existing error and
output-limit recovery behavior is unchanged.

## User shell output and busy admission

`!` output uses replacing `bash_output` snapshots, not SDK `bash_execution_update` deltas: the server retains only the last 16K UTF-16 units (at most 64 KiB UTF-8, without a leading half-surrogate), updates at most every 150ms, replays its latest snapshot on reconnect and clears it at completion/disposal. SSE may drop these under backpressure; persisted results remain authoritative. Each command has an id and a server `startedAt` that strictly increases within the runtime, including same-millisecond starts and clock rollback. Browsers retain only that server-time watermark (never compare it with their local clock) to reject older snapshots. An already-open idle observer adopts a valid snapshot through the same shell recovery path as initial mount. A newer command supersedes the observed card even if polling missed the idle gap: it invalidates the previous settlement loop/history reads, reloads the previous command's persisted result, and starts its own settlement loop. Late status responses, history completions and local POST completions cannot settle the newer card. The last command stays marked settled after its card clears so buffered snapshots cannot resurrect it. The pending card reuses `ToolCallBlock`'s result body, shows the last 20 lines, remains live while output arrives, and is replaced by persisted history on completion.

Truncated results keep their full-output actions in the expanded card's existing footer. Loading replaces the output above it and explicitly says the full output is shown (including an empty file). A 413 suggests downloading; missing files, malformed responses and network errors use localized unavailable feedback, never raw server errors. Failure leaves both retry and download available.

Unlike upstream, agent and user-shell execution remain mutually exclusive in this implementation. `sendQueued()` routes unquoted, image-free `!` / `!!` input to the command path, never to steering or follow-up; busy rejection explains the refusal and restores the originating draft. The server also refuses busy shell commands and refuses compaction while shell work is active. Parallel execution is deferred because this app has a parked compaction queue, shared Stop forced-cleanup deadline and post-bash subagent-report delivery; enabling it safely also requires reconciling SDK-deferred bash history against forced session reads, not just relaxing admission. Keeping mutual exclusion preserves existing Stop, completion and sidebar/favicon semantics.

## Tool step timing

Running tool steps reuse `StepDuration` and the existing row layout. The server
keeps each top-level call's start on `performance.now()`, replaying its start with
`elapsedMs` before the latest update. The client subtracts that elapsed value from
its own monotonic clock, never a server wall timestamp. Parallel calls therefore
have independent clocks. `tool_execution_end.durationMs` freezes the value while
batch siblings still run; reconnect keeps those frozen values and replaces only
running clocks. Result messages remove their clocks, and settlement clears the map.
SDK durations in persisted results still win; old history retains its timestamp
fallback. Thinking and standalone shell rows keep their existing timing behavior.
The wire already forwards start/end timing fields unchanged, covered by tests.

## Fork drafts

The user-message Fork button copies history *before* that message, then restores
its editable text (including skill-command recovery) and images under the new
session's draft key before switching. During a run, it copies on disk without
stopping the source. A just-delivered prompt gets its Fork id after pi persists
it; that id does not affect transcript keys, Edit or scroll anchors.
Deferred images are awaited only after a successful fork; a media failure stillkeeps the text. Fork naming is unchanged.
The session menu's fork-through-current-leaf action does not seed a draft.

## Model changes during a run

The model picker remains available while streaming (only a pending switch locks it).
`set_model` returns the selected model and effective thinking level; the composer
uses those directly, and recovers a failed/lost response from live `get_state`.
Neither path reloads history during a run or shell command. Normal end-of-run
reconciliation still reads the canonical file. SDK 1.5.2 re-reads its model before
each request, so a response already in flight keeps its original model. The server
keeps its existing `persist: true` behavior; startup preferences run before commands,
and branch recording adds nothing when the mid-run selection is already recorded.
History and context-replacement reads guard the stored `context.model` and
`context.thinkingLevel` as well as the override and live thinking state. They
capture the model-selection version, require no pending switch, and use the
existing monotonic request ids with an independent latest-applied selection fence.
Stale replies preserve the current selection while still loading messages. This
also protects the idle-switch order where a newer read clears the override before
an older reply arrives, and out-of-order reads within one selection version.
Command results, live-state recovery and failed-switch rollback advance the
version; mount live-thinking sync must still belong to the accepted history read.

## Summarization retry feedback

Compaction and branch summaries use the composer's existing retry banner for SDK
`summarization_retry_scheduled` (attempt, budget and error). The next attempt,
retry completion, and either compaction-end event clear it. The event wire already
passes these events through; no separate status UI or polling is needed.

## Transcript markers

Events that are not turns share one look (`TranscriptMarker`, `components/MessageView.tsx`, `.chat-marker*`): a centered dim line, icon + `label · detail · time`, and a chevron when there is something to open, which shows a bordered panel below that scrolls past `min(60vh, 480px)`. Routine runs (click opens the routine), compaction summaries (click or chevron opens the summary) and cache refreshes (`pi-web:cache-warm`, display-only, folded per idle stretch by `buildSessionContext()`; no chevron). Do not give a new event its own card style.

## Scroll edges

- The session list and file tree (`.scroll-fade-block`), Markdown code `<pre>` and `.markdown-table-wrap` fade only edges with more content beyond them. All use the chat's subtle 16px transparent/black linear-gradient style. Markdown code blocks never wrap: like tables and Mermaid, long lines (URLs, paths, ASCII diagrams) scroll the block sideways instead of reflowing to the pane width. Frozen streaming pieces size to their longest line (`width: max-content`), since `content-visibility` would otherwise clip them. This is a scroller edge mask, not another text-opacity tier; the existing `.chat-scroll-fade` behavior is unchanged.
- Pure CSS scroll-driven animations (`scroll(self block|inline)`) animate registered lengths from/to zero. Without overflow the timeline is inactive and both lengths stay zero; the `@supports` guard leaves unsupported browsers unmasked. No scroll listeners.
- An opaque second mask layer preserves classic scrollbar strips: vertical lists reuse the measured `--sidebar-scrollbar-gutter`; horizontal scrollers reserve the existing 5px WebKit scrollbar height on fine pointers (touch bars are hidden).
- Masks also clip positioned descendants even when the gradient is fully opaque. Session-row menus, the worktree picker (including its create/remove forms), and file menus/delete confirms portal to `document.body`. The worktree picker anchors to the project row in viewport coordinates, closes on list scroll/resize, and includes its portal in outside-click checks. Drag ghosts already portal; the multi-select action bar stays outside both masked lists. Inline rename fields and row actions intentionally remain in their rows; native `title` tooltips are browser chrome. Code actions and table chips sit outside the content `<pre>`/masked table scroller.
- Table borders and margins live on `.markdown-table-frame`, outside the masked `.markdown-table-wrap`. Keep the inner class and `.markdown-code-block pre` selectors stable for width fitting and image export. Export CSS disables masks/animations only in the html-to-image clone and expands the table and code frames to their content, leaving the live view unchanged.

- Display math in messages reuses the code block's copy glyph, 11px action and 1.5s Copied feedback to copy LaTeX. The borderless action overlays the formula's top-right corner and appears only on hover/focus (a tap on touch), so formulas keep their spacing; Copied feedback stays visible. Inline math and file previews stay unchanged. The source attribute is added only after sanitizing, before KaTeX; user HTML cannot supply it. Image exports omit the action.

## Composer caret visibility

The existing capped-height resize fast path is retained: do not reset an already-overflowing 200px textarea to `auto` on each keystroke. Programmatic focus/restore/history/queue prepend, selection replacements (including extension `set_editor_text`'s `insertText` path) and HTML-link paste explicitly reveal a collapsed caret at the text's end. Mid-text selections retain their scroll; no mirrored textarea/caret measurement is introduced.

## Composer paste recovery

Plain-text paste stays native (important for large text). The paste handler remembers event text, selection and current value; a zero-delay check uses `replaceTextareaRange` only if no input arrived, nobody prevented the event, the same textarea is still mounted, and its value is unchanged. This recovers Chrome abandoning insertion when dictation tools rewrite the clipboard mid-paste. Image paste and HTML-link-to-Markdown conversion retain their existing paths; recovered text synchronizes the same React draft/selection state as other programmatic inserts.

## Completion notifications

Page and Web Push completion notifications share `pi-session-complete:<id>` and stamp `data.shownAt`. Both the page's service-worker delivery and the push handler check `getNotifications({ tag })`, quietly replacing a notification under 10 seconds old (`renotify: false`) whichever arrives first. Every valid push still calls `showNotification` (required to keep iOS subscriptions healthy), retaining icon/badge and same-origin click validation. Older/missing timestamps or unsupported/failed listing alert normally; listing failure does not trigger window-notification fallback.

<!-- shortcut: a 10-second time window approximates one completion; use a shared run id if very short consecutive runs or delayed pushes need exact deduplication. -->

## Clipboard feedback

`copyText()` rejects refused `execCommand` copies as well as thrown failures and always removes its temporary textarea. Copy buttons only set Copied on success; failures remain silent (no unhandled rejection). The `/copy` command instead reports a localized permission-failure notice. `copyPendingText()` still starts Safari's pending-Blob clipboard write inside the user gesture. FileViewer/Mermaid/math already use the shared `MarkdownCopyButton`, which handles rejection; tab path actions also already handle it.

## Code gutters

- Code fence and file Source gutters use `data-line-number` + `::before`, with empty,
  aria-hidden DOM spans. Unlike `user-select:none` text nodes, these stay out of
  WebKit cross-line selection/copy; highlighter gutter widths stay unchanged.

## Images

- Prompt picks, paste and chat drops share `ChatInput.readPromptImageFile()`: preserve original bytes and sniff PNG/JPEG/GIF/WebP MIME from the bytes, keeping the 10 MiB/file and 10-image limits. The browser only falls back to the existing 2000px / JPEG 0.85 white-background re-encode at **4.5 MiB of base64** (3.375 MiB of file bytes) or above, including GIFs. This is conservative even for ordinary prompts: pi skips resizing when disabled. As before, unavailable/failed browser decoding or canvas encoding falls back to the original. `@` image mentions remain paths in the prompt, not browser-read attachments.
- Installed pi SDK 1.5.2: ordinary prompts normalize after `before_agent_start`, using the routed/current model's `inputLimits.images.resize`. `images.autoResize` defaults to true; missing model/profile fields fall back to 2000×2000, **strictly below 4,718,592 base64 bytes**, JPEG quality 80. In-limit PNG/JPEG/GIF/WebP bytes stay unchanged; other decodable formats convert to PNG. Resizing tries PNG first, then JPEG qualities 80/85/70/55/40 (the configured quality replaces the first 80), then shrinks dimensions by 0.75 until a candidate fits. Decode/conversion/resize failure omits the image with a text hint, never an oversized raw fallback. With auto-resize off, supported formats pass through unchecked (other formats still attempt PNG conversion); a 10 MiB PNG can reach the provider unchanged. Since pi 1.5.1 steering/follow-up images are normalized the same way when pi delivers them, so the wrapper queues them as sent (`lib/prompt-image-sdk.test.mjs` pins both paths). Image-generation dialog picks keep their separate >1 MiB, non-GIF compression because they do not use prompt normalization.

- Two kinds of image, two treatments. **Context the user gave the model** (composer attachments, `@` image files, user-message images, the image dialog's sources) is a numbered row of uniform 64px square thumbnails (`.image-thumb`, cover, top-aligned, `+N` after 6): the composer and the sent message look the same on purpose. **Content to read** (assistant markdown images, assistant image blocks, tool-result images, generated images) is shown size-capped (`min(60vh, 420–520px)`, never the natural size) and opens the viewer on click. Do not render a raw `<img>` in a message; use one of the components in the file map.
- Order matters: images go to the model in array order and `generate_image` refers to them as `attachment:N`, so the composer and the image dialog show the index and keep the array order the user sees. The dialog's edited result is `lockedCount` (fixed first, not movable or removable). `ImageAttachmentStrip` keys items by `src` length + tail + occurrence, never by index.
- `ImageViewer` is one component for mouse and touch (Pointer Events, `touch-action: none` on the stage). Mouse: wheel/±/0 zoom, drag to pan, click the image or backdrop to close, `←/→`; keys are bound on `document` (capture) because the focused button disables on the last image and focus falls to `<body>`. Touch: swipe switches (previous/current/next are rendered as a track, and the swipe target is one slide pitch = width + `SLIDE_GAP`, so the neighbour lands exactly on the centre slot; any mismatch shows as a jump at the end), pinch and double-tap zoom, drag down closes, a tap toggles the controls, and the controls start hidden with an opaque black, edge-to-edge picture. Arrows and zoom buttons are hidden under `pointer: coarse`. There is no double-click zoom on desktop because click closes.
- Zoom is shown as real scale: `zoom × fit`, where `fit` is displayed size over natural pixels (`fitOf`, the tighter axis), so 100% is the natural size. The minimum is fit-to-window, the maximum 400% of natural. Clicking the percentage toggles fit and 1:1.
- Touch reorder is done in the viewer, not by dragging thumbnails: an editable set (`edit` prop) shows move earlier / remove / move later there. A long-press drag among 64px thumbnails was hard to aim and fought scrolling. Desktop reorders by dragging thumbnails or `Alt+←/→`.
- Enter and exit are one plain fade of the whole overlay (0.25s / 0.2s); the full-screen touch motions are slower (340ms) than menu-surface-in (0.12s) because travel distance changes the perceived speed. All closes go through `requestClose()` so the exit plays before the parent unmounts.
- History (`deferMedia`) serves user-message and tool-result images as URLs to `/entries/[entryId]/tool-result-image`, which returns the original bytes (no resize/recompression) with an immutable cache header; user images that are too large or of an unsupported type stay inline, never dropped. Edit/restore (`getUserMessageDraftImages`) fetches URL images back to base64; fork and export read the file server-side. Thumbnails use `loading="lazy"` and `decoding="async"`.
- Dev note: after editing `app/globals.css`, Turbopack has repeatedly kept serving the old CSS (HTML links a stale chunk). Confirm with `document.styleSheets`; appending and removing a comment forces a rebuild, and a restart with `.next` backed up (see troubleshooting) fixes a persistent case.

## File panel

- Closed by default (a reload restores it from `sessionStorage`). It opens from the top bar's "Changes N" (Changes · All uncommitted), the panel toggle, a turn card's Review (Changes · this turn), and any file, terminal or browser opened from elsewhere. The new-session page shows none (see New-session page). Phones show it full screen with a back arrow first in its tab row (opened from Changes N, `⋯` › Files, or a file), 641–959px as an overlay with a scrim and a × last, ≥960px inline (closed from the top bar's panel toggle).
- The tab row is text only: two fixed views, "Changes" and "Files", then a short rule, then the content tabs (files, diffs, terminals, browser), then "+" (Terminal, Browser, Open file… which focuses the Files search). The current tab is underlined `inset 0 -2px 0 var(--text)`; no accent, icons, per-tab rules or fills. Fixed views have no ×; closing the last content tab leaves the panel open on the last fixed view (`pi-web:panel-view` remembers which, and whether it was open).
- The fixed views follow the active session's cwd: the sidebar's selected cwd, moved by `lib/explorer-cwd.ts` (a click on a session in another live worktree moves it; the same checkout does not). A reveal, Show in Files, a project row's Files action or the Files view's worktree menu moves it too, and the sidebar's selected project follows.
- Changes: a scope menu, "Uncommitted · N files" or "Uncommitted · this turn's N files" (only the uncommitted files the focused chat's last answered turn wrote, in the order it wrote them, `lib/turn-changes.ts`; files of that turn without uncommitted changes are counted in a note), and the total `+N −M`. Rows follow VS Code / Cursor source control: file-type icon, name (struck through when deleted), folder (11px `--text-dim`), `+N −M` from `/api/git/status` (each file carries its own uncommitted counts), then the status letter in its git color (M `--warning`, A/U `--success`, R `--accent`, D/C `--danger`). Numbers are always the file's whole uncommitted diff: git has no per-turn counts. A row opens its diff. Fetched only while shown.
- Files: the explorer (tree with dim status letters, search, upload, drag to the composer for `@` mentions, reveal, collapse all, refresh) with its search field always on top and a worktree menu when the project has more than one checkout. Creating or removing worktrees is on the new-session page. The tree reads status letters only (`lines=0`).
- A turn's written files are a card under the answer: "This turn wrote N files · Review ›" on the session's last turn, "Wrote N files" on earlier ones (no Review: there is no per-turn scope for them), then one row per file with name and folder, opening its diff. No per-file counts. While the panel is open every card folds to its title row.
- Tabs are one list for the window and never follow the sidebar project (switching projects on the left neither swaps nor stashes them). A single click in the explorer opens a preview tab (dotted underline, at most one, replaced by the next single click); double-clicking the row or the tab pins it, and every other way of opening a file opens pinned. Tab metadata and viewer state (never contents) persist in `sessionStorage` (`pi-file-tabs`), so a reload brings them back.
- The active viewer and two recently viewed ones stay mounted, hidden with `content-visibility: hidden` (keeps their scroll position); hidden viewers pause the file watch and skip git diff refreshes until shown again.
- Find (`components/FileFindBar.tsx`): Cmd/Ctrl+F once the viewer was clicked or holds focus, or the toolbar button. Searches the rendered text of the loaded part via the CSS Custom Highlight API; `:N` jumps to line N in Source. Not available in the CSV table or HTML preview.
- Multi-chunk loads (refresh, Load all) publish once (`lib/text-chunk-reader.ts`); a failed refresh keeps the content and shows a retry bar.
- Maximize (panel header, not on phones) makes the whole panel cover the Pi Web page via CSS only, so viewers, terminals and the browser frame keep their state; the rest of the app is `inert`. Esc restores, except inside a terminal or text field (Esc belongs there); sending a selection or `@` mention to the chat also restores.
- Images in a markdown preview and image files open in the shared zoom viewer; linked images keep their link.
