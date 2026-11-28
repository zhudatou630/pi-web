export interface ExtensionIssue {
  type: "warning" | "error";
  message: string;
}

export function collectExtensionIssues(sources: {
  diagnostics?: readonly { type: string; message: string; path?: string }[];
  /** `modelRuntime.getError()`: pi 1.7+ repeats it as a diagnostic, but the composer's banner already shows it. */
  modelsJsonError?: string;
  extensions?: {
    errors?: readonly { path: string; error: string }[];
    warnings?: readonly { path: string; warning: string }[];
  };
}): ExtensionIssue[] {
  const withPath = (message: string, path?: string) => path && !message.includes(path) ? `${path}: ${message}` : message;
  const modelsJsonDiagnostic = sources.modelsJsonError && `models.json error: ${sources.modelsJsonError}`;
  return [
    ...(sources.diagnostics ?? []).flatMap((issue) => (issue.type === "error" || issue.type === "warning") && issue.message !== modelsJsonDiagnostic
      ? [{ type: issue.type, message: withPath(issue.message, issue.path) } as ExtensionIssue] : []),
    ...(sources.extensions?.errors ?? []).map((issue) => ({ type: "error" as const, message: withPath(issue.error, issue.path) })),
    ...(sources.extensions?.warnings ?? []).map((issue) => ({ type: "warning" as const, message: withPath(issue.warning, issue.path) })),
  ];
}
