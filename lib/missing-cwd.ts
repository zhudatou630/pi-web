// Read fields, not Error identity: Next routes may use separate module bundles.
export function missingCwdFromBody(value: unknown): { reason: "cwd-missing"; cwd: string } | null {
  if (!value || typeof value !== "object" || !("reason" in value) || value.reason !== "cwd-missing"
    || !("cwd" in value) || typeof value.cwd !== "string" || !value.cwd) return null;
  return { reason: "cwd-missing", cwd: value.cwd };
}

export function cwdMissingError(cwd: string): Error {
  return Object.assign(new Error(`Directory does not exist: ${cwd}`), { reason: "cwd-missing", cwd });
}
