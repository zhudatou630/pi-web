"use client";

import { useI18n } from "@/hooks/useI18n";
import { SubagentIcon } from "./SubagentIcon";

/**
 * The top bar's Agents entry (docs/ui.md, Tabs and top bars), beside "back to main agent": the
 * Agents panel glyph with a count at its corner. While subagents run the count is how many still
 * run, on a solid breathing badge; afterwards it is the total, dim. An unseen failure turns the
 * badge red until the panel is opened. Side chats show the glyph alone (they are not counted).
 */
export function AgentsTopBarButton({ count, running, failed, open, onToggle }: {
  count: number;
  running: number;
  failed: number;
  open: boolean;
  onToggle: (anchor: HTMLElement) => void;
}) {
  const { t } = useI18n();
  const summary = [
    t("agentSwitcher.title"),
    running > 0 && t("agentSwitcher.runningCount", { count: running }),
    failed > 0 && t("agentSwitcher.failedCount", { count: failed }),
    count > 0 && t("agentSwitcher.count", { count }),
  ].filter(Boolean).join(" · ");
  return (
    <button
      type="button"
      className="workspace-header-action agents-top-bar-action"
      title={summary}
      aria-label={summary}
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-controls="workspace-top-panel"
      data-top-panel-trigger="agents"
      onClick={(event) => onToggle(event.currentTarget)}
    >
      <SubagentIcon size={16} />
      {count > 0 && (
        <span
          className="agents-badge"
          data-state={failed > 0 ? "failed" : running > 0 ? "running" : undefined}
          data-breathing={running > 0 || undefined}
          aria-hidden="true"
        >
          {running > 0 ? running : count}
        </span>
      )}
    </button>
  );
}
