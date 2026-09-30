/**
 * Parse what the user typed or pasted: one server's config, `{ name: config }`, or a whole
 * `{ "mcpServers": { ... } }` block copied from another client's docs.
 */
export function parseMcpDraft(name: string, json: string): [string, Record<string, unknown>][] {
  const parsed: unknown = JSON.parse(json);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("JSON must be an object");
  const record = parsed as Record<string, unknown>;
  if ("command" in record || "url" in record) return [[name.trim(), record]];
  const servers = (record.mcpServers ?? record) as Record<string, unknown>;
  const entries = Object.entries(servers).filter((entry): entry is [string, Record<string, unknown>] => (
    typeof entry[1] === "object" && entry[1] !== null && !Array.isArray(entry[1])
  ));
  if (entries.length === 0) throw new Error("No server config found");
  // One pasted entry takes the name typed in the form, when there is one.
  return entries.length === 1 && name.trim() ? [[name.trim(), entries[0]![1]]] : entries;
}
