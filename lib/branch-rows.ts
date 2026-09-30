import type { SessionTreeNode } from "@/lib/types";

export interface BranchRow {
  key: string;
  /** Ancestor columns: "pass" draws a vertical line, "blank" leaves the column empty. */
  levels: ("pass" | "blank")[];
  /** This row's own connector to its fork point; null on the trunk and inside a flat run. */
  connector: "branch" | "last" | null;
  preview: string;
  /** User turns this segment covers (1-based, inclusive); 0/0 when it has none. */
  turnStart: number;
  turnEnd: number;
  onPath: boolean;
  /** The row that holds the current position. */
  current: boolean;
  /** First user message of this segment: where the chat scrolls to on click. */
  anchorId?: string;
  /** Where a click switches to (newest leaf below this row); null on the active path, where the user already is. */
  leafId: string | null;
}

const turnsOf = (node: SessionTreeNode) => node.userTurns ?? 0;

// Nodes from a root to the active leaf. Iterative: chains can be thousands deep.
function activeChain(tree: SessionTreeNode[], leafId: string | null): Set<SessionTreeNode> {
  const chain = new Set<SessionTreeNode>();
  if (!leafId) return chain;
  const parent = new Map<SessionTreeNode, SessionTreeNode | null>(tree.map((root) => [root, null]));
  const stack = [...tree];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.entry.id === leafId || node.compressedEntryIds?.includes(leafId)) {
      for (let n: SessionTreeNode | null = node; n; n = parent.get(n) ?? null) chain.add(n);
      return chain;
    }
    for (const child of node.children) {
      parent.set(child, node);
      stack.push(child);
    }
  }
  return chain;
}

// Newest leaf (by timestamp) of every subtree, children before parents.
function newestLeaves(tree: SessionTreeNode[]): Map<SessionTreeNode, SessionTreeNode> {
  const order: SessionTreeNode[] = [];
  const stack = [...tree];
  while (stack.length > 0) {
    const node = stack.pop()!;
    order.push(node);
    for (const child of node.children) stack.push(child);
  }
  const newest = new Map<SessionTreeNode, SessionTreeNode>();
  for (let i = order.length - 1; i >= 0; i--) {
    const node = order[i];
    let best = node.children.length === 0 ? node : undefined;
    for (const child of node.children) {
      const leaf = newest.get(child)!;
      if (!best || leaf.entry.timestamp > best.entry.timestamp) best = leaf;
    }
    newest.set(node, best!);
  }
  return newest;
}

/**
 * Flatten the projected session tree into display rows, depth first.
 * Same shape rule as pi's /tree: a single-child run stays on one row and one
 * indent, only a fork indents its versions. The version holding the current
 * position is listed first.
 */
export function buildBranchRows(tree: SessionTreeNode[], activeLeafId: string | null): BranchRow[] {
  const chain = activeChain(tree, activeLeafId);
  const newest = newestLeaves(tree);
  const rows: BranchRow[] = [];
  const ordered = (nodes: SessionTreeNode[]) => [...nodes.filter((n) => chain.has(n)), ...nodes.filter((n) => !chain.has(n))];
  type Ctx = { node: SessionTreeNode; levels: BranchRow["levels"]; connector: BranchRow["connector"]; base: number };
  const stack: Ctx[] = ordered(tree)
    .map((node, i, all): Ctx => ({ node, levels: [], connector: tree.length > 1 ? (i === all.length - 1 ? "last" : "branch") : null, base: 0 }))
    .reverse();

  while (stack.length > 0) {
    const { node: first, levels, connector, base } = stack.pop()!;
    // Merge a single-child run into one row.
    let last = first;
    let turns = turnsOf(first);
    let shown = first.branchPreview;
    let userPreview = shown?.role === "user" ? shown : undefined;
    while (last.children.length === 1) {
      last = last.children[0];
      turns += turnsOf(last);
      shown ??= last.branchPreview;
      if (!userPreview && last.branchPreview?.role === "user") userPreview = last.branchPreview;
    }
    const preview = shown?.text ?? "";
    const onPath = chain.has(first);
    rows.push({
      key: first.entry.id,
      levels,
      connector,
      preview,
      anchorId: userPreview?.entryId,
      turnStart: turns > 0 ? base + 1 : 0,
      turnEnd: turns > 0 ? base + turns : 0,
      onPath,
      current: onPath && !last.children.some((c) => chain.has(c)),
      leafId: onPath ? null : newest.get(last)!.entry.id,
    });
    const children = ordered(last.children);
    const childLevels = connector ? [...levels, connector === "branch" ? "pass" as const : "blank" as const] : levels;
    for (let i = children.length - 1; i >= 0; i--) {
      stack.push({ node: children[i], levels: childLevels, connector: i === children.length - 1 ? "last" : "branch", base: base + turns });
    }
  }
  return rows;
}
