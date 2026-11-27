"use client";

import { useI18n } from "@/hooks/useI18n";
import { SubagentIcon } from "./SubagentIcon";

/**
 * In the dock whenever the session has subagents or side chats (docs/ui.md, Composer): "Agents N".
 * While some run it reads "Agents 2/6": the running count in `--text`, breathing like the sidebar's
 * running dot, over the dim total; no dot. The word stays English like the model and thinking ids
 * beside it; narrow docks swap it for the Agents panel glyph.
 */
export function AgentsDockButton({ count, running, open, onToggle }: {
  count: number;
  running: number;
  open: boolean;
  onToggle: (anchor: HTMLElement) => void;
}) {
  const { t } = useI18n();
  const summary = running > 0
    ? `${t("agentSwitcher.title")} · ${t("agentSwitcher.runningCount", { count: running })} · ${t("agentSwitcher.count", { count })}`
    : `${t("agentSwitcher.title")} · ${t("agentSwitcher.count", { count })}`;
  return (
    <button
      type="button"
      className="composer-btn composer-agents"
      data-running={running > 0 || undefined}
      title={summary}
      // Named by its visible text (voice control says "Agents"); the localized counts are the tooltip/description.
      aria-label={running > 0 ? `Agents ${running}/${count}` : `Agents ${count}`}
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-controls="workspace-top-panel"
      data-top-panel-trigger="agents"
      onClick={(event) => onToggle(event.currentTarget)}
    >
      <SubagentIcon size={12} className="composer-agents-icon" />
      <span className="composer-dock-label">Agents</span>
      <span className="composer-dock-count">
        {running > 0 ? <><span className="composer-agents-running">{running}</span>/{count}</> : count}
      </span>
    </button>
  );
}
