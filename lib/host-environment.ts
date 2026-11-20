// Children that run in a project folder must not see Pi Web's own runtime
// settings or login secret (docs/adr/0001-isolate-project-command-environments.md).
function isHostRuntimeVariable(name: string, platform: NodeJS.Platform): boolean {
  const comparableName = platform === "win32" ? name.toUpperCase() : name;
  return comparableName === "PORT"
    || comparableName === "NODE_ENV"
    || comparableName === "PI_WEB_PASSWORD"
    || comparableName.startsWith("NEXT_");
}

export function sanitizeProjectCommandEnvironment(
  baseEnvironment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const environment = { ...baseEnvironment };
  for (const name of Object.keys(environment)) {
    if (isHostRuntimeVariable(name, platform)) delete environment[name];
  }
  return environment;
}

// A repository's own config can run programs from git (core.fsmonitor, hooks).
// LC_ALL=C pins messages that callers match on.
export function projectGitEnvironment(): NodeJS.ProcessEnv {
  return { ...sanitizeProjectCommandEnvironment(process.env), LC_ALL: "C" };
}
