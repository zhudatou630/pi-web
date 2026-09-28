# Built-in sub-agent activation and extension precedence

Pi Web's integrated sub-agent implementation is an inline, hidden extension.
It is enabled by default and controlled by the global
`~/.pi/agent/agents/settings.json` setting `builtInEnabled`.
An explicit `false` turns it off; a missing file or field stays on.

A project can override that default in either direction: `projects` in the same
file maps sidebar project roots (`resolveProject().projectRoot`, so linked
worktrees share the switch) to on/off, and the project wins. The global switch is
therefore the default for projects without their own setting. This matches
resource overrides and covers "only this project uses it" (default off, one project
on) as well as "every project but this one". A first version was off-only ("global
on and project not listed", `disabledProjects`); that list still reads as `false`
entries and is rewritten on the next write. The setting lives in the global file
rather than the project's `.pi/settings.json` so nothing is written into the project
tree and no worktree sync is needed; the cost is that renaming or moving a directory
drops its entry. Both `Agent` start and resume check the effective state against the
parent's cwd, so an earlier child cannot be resumed where sub-agents are off. The
factory also registers no tools when no profile is enabled.

The inline extension factory remains installed in every ordinary, non-Chat-only
resource loader so an AgentSession reload can enable or disable its tools without
recreating the wrapper. When disabled, the factory registers no tools. A runtime
guard also rejects stale `Agent` calls after the setting is turned off but before
the parent session is reloaded.

When the integrated extension is enabled, it takes precedence over an enabled
legacy `pi-subagents` extension. A legacy extension is suppressed when its package
source or path identifies it as `pi-subagents` and it registers any of the reserved
tool names: `Agent`, `get_subagent_result`, or `steer_subagent`. Unrelated extensions
are never removed solely because they use one of those names; the SDK reports those
collisions normally.

When the integrated extension is disabled, Pi Web does not suppress the legacy
package, so users can continue to manage and use that implementation through the
Plugins settings. Existing child sessions remain readable, and already-running
children are not aborted when the setting changes.

## Profiles in the Agents page

Sub-agents are a feature a project either uses or does not, unlike skills or
extensions where a project picks a subset. So the only per-project control is the
project switch above. The profile list is the user's global configuration: the
built-in profiles are ordinary entries that can be edited or disabled directly.
Editing writes a global copy shown as "modified" with Restore default; disabling an
untouched built-in writes a global `enabled: false` stub so its definition still
follows Pi Web updates. Project and workspace profile files remain valid (pi and
shared repositories use them) and are shown as "project file", but the UI does not
create them.
