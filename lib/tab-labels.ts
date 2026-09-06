import { getFileName, normalizeFilePathSlashes } from "./file-paths";

export interface PathLabelItem {
  id: string;
  path: string;
  /** Existing tab label used as the grouping and display baseline. */
  label?: string;
}

function pathSegments(filePath: string): string[] {
  const normalized = normalizeFilePathSlashes(filePath).replace(/\/+$/, "");
  if (!normalized) return [];
  if (/^[a-zA-Z]:$/.test(normalized)) return [normalized];
  return normalized.split("/").filter((segment, index) => segment.length > 0 || index === 0);
}

function parentLabel(segments: string[], extraParents: number): string {
  if (extraParents <= 0) return "";
  const start = Math.max(0, segments.length - 1 - extraParents);
  return segments.slice(start, -1).join("/") || segments[0] || "";
}

function displayName(name: string, parent: string): string {
  return parent ? `${name} · ${parent}` : name;
}

function baselineLabel(item: PathLabelItem): string {
  const label = item.label?.trim();
  if (label) return label;
  return getFileName(item.path) || item.path;
}

function countLabels(rendered: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const label of rendered) counts.set(label, (counts.get(label) ?? 0) + 1);
  return counts;
}

/**
 * Within one visible tab set, keep each item's existing label and append the
 * shortest unique parent suffix only where that label conflicts.
 */
export function disambiguatePathLabels(items: readonly PathLabelItem[]): Map<string, string> {
  const labels = new Map<string, string>();
  const groups = new Map<string, PathLabelItem[]>();

  for (const item of items) {
    const name = baselineLabel(item);
    const group = groups.get(name);
    if (group) group.push(item);
    else groups.set(name, [item]);
  }

  for (const [name, group] of groups) {
    if (group.length === 1) {
      labels.set(group[0].id, name);
      continue;
    }

    const segments = group.map((item) => pathSegments(item.path));
    const maxParents = segments.map((parts) => Math.max(0, parts.length - 1));
    const depths = group.map(() => 0);
    let expanded = true;
    while (expanded) {
      expanded = false;
      const rendered = group.map((_, index) => displayName(name, parentLabel(segments[index], depths[index])));
      const counts = countLabels(rendered);
      for (let index = 0; index < group.length; index += 1) {
        if ((counts.get(rendered[index]) ?? 0) <= 1) continue;
        if (depths[index] >= maxParents[index]) continue;
        depths[index] += 1;
        expanded = true;
      }
    }

    const rendered = group.map((_, index) => displayName(name, parentLabel(segments[index], depths[index])));
    const counts = countLabels(rendered);
    group.forEach((item, index) => {
      labels.set(item.id, (counts.get(rendered[index]) ?? 0) > 1 ? name : rendered[index]);
    });
  }

  return labels;
}
