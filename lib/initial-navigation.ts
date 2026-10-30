export interface InitialNavigation {
  requestedCwd: string | null;
  sessionId: string | null;
  /** `?routines` opens the Routines list, `?routines=<id>` one routine; null = the chat. */
  routines: string | null;
}

export function getInitialNavigation(searchParams: Pick<URLSearchParams, "get">): InitialNavigation {
  const requestedCwd = searchParams.get("cwd")?.trim() || null;

  return {
    requestedCwd,
    sessionId: requestedCwd ? null : searchParams.get("session"),
    routines: requestedCwd ? null : searchParams.get("routines"),
  };
}
