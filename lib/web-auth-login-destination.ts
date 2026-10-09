/** Resolve login's next query with the browser's URL rules, not a slash check. */
export function safeLoginDestination(next: string | null, origin: string): string {
  if (!next?.startsWith("/")) return "/";
  try {
    const url = new URL(next, origin);
    return url.origin === origin ? url.href : "/";
  } catch {
    return "/";
  }
}
