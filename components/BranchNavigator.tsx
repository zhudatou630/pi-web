"use client";

import { useState, useMemo } from "react";
import type { BranchPreview, SessionEntry, SessionTreeNode } from "@/lib/types";
import { iconStroke } from "./iconStroke";
import { useI18n } from "@/hooks/useI18n";
import { buildBranchRows } from "@/lib/branch-rows";

interface Props {
  tree: SessionTreeNode[];
  activeLeafId: string | null;
  /** `leafId` is the branch to switch to (null when already on it); `anchorEntryId` is the message to scroll to. */
  onLeafChange: (leafId: string | null, anchorEntryId?: string) => void;
  /** When true, renders only a top-bar button; the host renders `BranchTreeList` in its panel */
  inline?: boolean;
  /** Controlled open state for inline mode */
  open?: boolean;
  /** Called when the button is clicked in inline mode */
  onToggle?: () => void;
  /** Whether a session is currently active (used to show appropriate empty reason) */
  hasSession?: boolean;
  /** When inline, render icon-only (no text label) to save horizontal space */
  compact?: boolean;
  /** Disable button when no branches exist instead of hiding it */
  disabled?: boolean;
}

// Find the visible entry IDs on the path from root to activeLeafId.
// Iterative DFS: a linear session degrades into a chain whose depth equals the
// entry count, so a recursive search overflows the call stack. Walk with an
// explicit stack instead (paths accumulate depth, not the call stack).
export function buildActivePath(nodes: SessionTreeNode[], targetId: string | null): Set<string> {
  if (!targetId) return new Set();
  const target = targetId;
  const stack: { node: SessionTreeNode; path: string[] }[] = nodes.map((n) => ({ node: n, path: [n.entry.id] }));
  while (stack.length > 0) {
    const { node, path } = stack.pop()!;
    if (node.entry.id === target || node.compressedEntryIds?.includes(target)) {
      return new Set(path);
    }
    for (const child of node.children) {
      stack.push({ node: child, path: [...path, child.entry.id] });
    }
  }
  return new Set();
}

function isMessageEntry(entry: SessionEntry): boolean {
  // Transcript system messages hold the prompt, not a turn, so they never label a branch.
  return entry.type === "message" && "message" in entry && entry.message.role !== "system";
}

// Compress a visible linear chain into the first branching/leaf node.
// Server-side compressed IDs also count as skipped nodes.
// branchPreview is the bounded preview of the first message on the source
// chain. labelEntry keeps unprojected/test shapes working as a fallback.
export function compressChain(node: SessionTreeNode): {
  node: SessionTreeNode;
  skipped: number;
  branchPreview?: BranchPreview;
  labelEntry: SessionEntry;
} {
  let current = node;
  let branchPreview = current.branchPreview;
  let labelEntry: SessionEntry | null = isMessageEntry(current.entry) ? current.entry : null;
  let skipped = current.compressedEntryIds?.length ?? 0;
  while (current.children.length === 1) {
    current = current.children[0];
    branchPreview ??= current.branchPreview;
    if (!labelEntry && isMessageEntry(current.entry)) labelEntry = current.entry;
    skipped += 1 + (current.compressedEntryIds?.length ?? 0);
  }
  return { node: current, skipped, branchPreview, labelEntry: labelEntry ?? current.entry };
}

// Top-level rows of the panel: with multiple roots (a branch was started from
// the very first message) the roots themselves are the branches; otherwise the
// children of the first branching node.
export function selectTopLevelBranches(tree: SessionTreeNode[]): SessionTreeNode[] {
  if (tree.length > 1) return tree;
  if (tree.length === 0) return [];
  const first = compressChain(tree[0]).node;
  return first.children.length > 1 ? first.children : [];
}

// Does the tree have any branching at all? Iterative: a linear chain has no
// branching but recursing over it would overflow the stack, so walk with a stack.
export function hasSessionBranches(nodes: SessionTreeNode[]): boolean {
  // Sessions branched from the very first message have multiple root nodes.
  if (nodes.length > 1) return true;
  const stack: SessionTreeNode[] = [...nodes];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.children.length > 1) return true;
    for (const child of node.children) stack.push(child);
  }
  return false;
}

const GUIDE_COL = 16;
const guideLine = { position: "absolute", background: "var(--border)" } as const;

/** Branch panel body: the session tree, one row per segment; only forks indent. */
export function BranchTreeList({ tree, activeLeafId, onLeafChange, hasSession }: Pick<Props, "tree" | "activeLeafId" | "onLeafChange" | "hasSession">) {
  const { t } = useI18n();
  const rows = useMemo(() => buildBranchRows(tree, activeLeafId), [tree, activeLeafId]);
  const reason = !hasSession
    ? t("i18n.noActiveSession")
    : !hasSessionBranches(tree)
      ? t("i18n.noBranches")
      : null;
  if (reason) {
    return <div style={{ padding: "10px 16px", fontSize: 12, lineHeight: 1.4, color: "var(--text-muted)" }}>{reason}</div>;
  }
  return (
    <div style={{ padding: "6px 8px 8px", maxHeight: 320, overflowY: "auto" }}>
      {rows.map((row) => {
        const range = row.turnEnd === 0
          ? ""
          : t("i18n.branchTurnRange", { range: row.turnStart === row.turnEnd ? row.turnStart : `${row.turnStart}–${row.turnEnd}` });
        return (
          <button
            key={row.key}
            type="button"
            title={row.preview}
            className="workspace-header-action"
            onClick={() => { if (row.leafId || row.anchorId) onLeafChange(row.leafId, row.anchorId); }}
            aria-current={row.current ? "true" : undefined}
            style={{
              display: "flex",
              alignItems: "stretch",
              width: "100%",
              minHeight: 26,
              padding: "0 8px 0 0",
              border: "none",
              borderRadius: 4,
              background: row.current ? "var(--bg-selected)" : "none",
              cursor: row.leafId || row.anchorId ? "pointer" : "default",
              textAlign: "left",
              color: row.current ? "var(--text)" : "var(--text-muted)",
            }}
          >
            {row.levels.map((level, i) => (
              <span key={i} style={{ width: GUIDE_COL, flexShrink: 0, position: "relative" }}>
                {level === "pass" && <span style={{ ...guideLine, left: 3, top: 0, bottom: 0, width: 1 }} />}
              </span>
            ))}
            {row.connector && (
              <span style={{ width: GUIDE_COL, flexShrink: 0, position: "relative" }}>
                <span style={{ ...guideLine, left: 3, top: 0, bottom: row.connector === "last" ? "50%" : 0, width: 1 }} />
                <span style={{ ...guideLine, left: 3, top: "50%", width: GUIDE_COL - 3, height: 1 }} />
              </span>
            )}
            <span style={{ display: "flex", alignItems: "center", flex: 1, minWidth: 0, gap: 6 }}>
              <span style={{
                width: 7,
                height: 7,
                borderRadius: "50%",
                flexShrink: 0,
                boxSizing: "border-box",
                background: row.current ? "var(--accent)" : row.onPath ? "var(--text-muted)" : "none",
                border: row.onPath ? "none" : "1px solid var(--text-dim)",
              }} />
              <span style={{ flex: 1, minWidth: 0, fontSize: 12, lineHeight: 1.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {row.preview || "…"}
              </span>
              {range && <span style={{ flexShrink: 0, fontSize: 11, lineHeight: 1.4, color: "var(--text-dim)", fontVariantNumeric: "tabular-nums" }}>{range}</span>}
              {row.current && <span style={{ flexShrink: 0, fontSize: 10, lineHeight: 1.4, color: "var(--accent)" }}>{t("i18n.branchCurrent")}</span>}
            </span>
          </button>
        );
      })}
    </div>
  );
}

export function BranchNavigator({ tree, activeLeafId, onLeafChange, inline, open: openProp, onToggle, hasSession, compact, disabled = false }: Props) {
  const { t } = useI18n();
  const [openInternal, setOpenInternal] = useState(false);
  const open = openProp !== undefined ? openProp : openInternal;

  const noBranchReason = !hasSession
    ? t("i18n.noActiveSession")
    : !hasSessionBranches(tree)
      ? t("i18n.noBranches")
      : null;

  const topLevel = selectTopLevelBranches(tree);
  const hasContent = !noBranchReason && topLevel.length > 0;
  const isEffectiveDisabled = disabled || !hasContent;

  const branchIcon = (
    <svg width={compact ? 13 : 12} height={compact ? 13 : 12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={iconStroke(compact ? 13 : 12)} strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, display: "block" }}>
      <line x1="6" y1="3" x2="6" y2="15" />
      <circle cx="18" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M18 9a9 9 0 0 1-9 9" />
    </svg>
  );

  const chevron = (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="var(--text-dim)" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" style={{ marginLeft: 2, transform: open ? "rotate(180deg)" : "none", transition: "transform 0.15s" }}>
      <polyline points="2 3.5 5 6.5 8 3.5" />
    </svg>
  );


  if (inline) {
    return (
      <div style={{ height: "100%", display: "flex", alignItems: "stretch" }}>
        <button
          className="workspace-header-action"
          disabled={isEffectiveDisabled}
          onClick={() => {
            if (isEffectiveDisabled) return;
            if (onToggle) {
              onToggle();
            } else {
              setOpenInternal((v) => !v);
            }
          }}
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: compact ? "center" : undefined,
            gap: compact ? 0 : 6,
            height: "100%",
            width: compact ? 30 : undefined,
            padding: compact ? 0 : "0 12px",
            background: open ? "var(--bg-selected)" : "none",
            border: "none",
            cursor: isEffectiveDisabled ? "not-allowed" : "pointer",
            color: isEffectiveDisabled ? "var(--text-dim)" : open ? "var(--text)" : "var(--text-muted)",
            opacity: isEffectiveDisabled ? 0.45 : 1,
            fontSize: 11,
            whiteSpace: "nowrap",
            transition: "color 0.1s, background 0.1s, opacity 0.1s",
          }}
          onMouseEnter={(e) => {
            if (isEffectiveDisabled) return;
            e.currentTarget.style.color = "var(--text)";
            e.currentTarget.style.background = "var(--bg-hover)";
          }}
          onMouseLeave={(e) => {
            if (isEffectiveDisabled) return;
            e.currentTarget.style.color = open ? "var(--text)" : "var(--text-muted)";
            e.currentTarget.style.background = open ? "var(--bg-selected)" : "none";
          }}
          title={isEffectiveDisabled ? t("i18n.noBranches", { defaultValue: "没有分支" }) : t("i18n.branches")}
          aria-label={t("i18n.branches")}
          aria-pressed={open}
          data-top-panel-trigger="branches"
        >
          {branchIcon}
          {!compact && <span style={{ lineHeight: 1 }}>{t("i18n.branches")}</span>}
        </button>
      </div>
    );
  }

  return (
    <div style={{ borderBottom: "1px solid var(--border)", background: "var(--bg)", flexShrink: 0, position: "relative" }}>
      {/* Header toggle */}
      <button
        onClick={() => setOpenInternal((v) => !v)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          width: "100%",
          padding: "5px 12px",
          background: "none",
          border: "none",
          cursor: "pointer",
          color: "var(--text-muted)",
          fontSize: 11,
          textAlign: "left",
        }}
      >
        {branchIcon}
         <span style={{ color: "var(--text-muted)" }}>{t("i18n.branches")}</span>
        {chevron}
      </button>

      {/* Tree panel - overlay */}
      {open && (
        <div className="branch-dropdown" style={{
          position: "absolute",
          top: "100%",
          left: 0,
          right: 0,
          background: "var(--bg)",
          borderBottom: "1px solid var(--border)",
          boxShadow: "0 4px 12px rgba(0,0,0,0.1)",
          zIndex: 100,
        }}>
          <BranchTreeList tree={tree} activeLeafId={activeLeafId} onLeafChange={onLeafChange} hasSession={hasSession} />
        </div>
      )}
    </div>
  );
}
