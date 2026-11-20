import { existsSync } from "node:fs";
import { join } from "node:path";
import { DefaultPackageManager } from "@earendil-works/pi-coding-agent";

type PackageManagerOptions = ConstructorParameters<typeof DefaultPackageManager>[0];
type SpawnCaptureCommand = (
  command: string,
  args: string[],
  options?: { cwd?: string; env?: Record<string, string | undefined>; timeoutMs?: number },
) => unknown;

/**
 * Where an `npm view` version lookup runs: pi's user npm prefix, whose config (.npmrc) its user
 * installs read. pi runs it in the selected project folder instead, trusted or not, where npm
 * reads that folder's .npmrc (its own registry, `${PI_WEB_PASSWORD}` expanded into the token
 * sent there) and Windows looks a bare `npm` up first.
 * shortcut: a project-scope package is looked up with the user config, not its `.pi/npm` one;
 * a registry only that folder configures falls back to pi's reinstall-on-failed-lookup.
 */
export function npmLookupFolder(agentDir: string): string {
  const prefix = join(agentDir, "npm");
  return existsSync(prefix) ? prefix : agentDir;
}

/** `[...npmCommand.args, "view", spec, "version", "--json"]`, as pi's getLatestNpmVersion builds it. */
function isNpmVersionLookup(args: string[]): boolean {
  return args.length >= 4 && args.at(-4) === "view" && args.at(-2) === "version" && args.at(-1) === "--json";
}

/** pi's package manager with its version lookups run outside the selected project folder. */
export function createHostPackageManager(options: PackageManagerOptions): DefaultPackageManager {
  const manager = new DefaultPackageManager(options);
  // Private SDK method; lib/host-package-manager.test.mjs drives a public update through it.
  const host = manager as unknown as { spawnCaptureCommand?: SpawnCaptureCommand };
  const spawnCaptureCommand = host.spawnCaptureCommand;
  if (typeof spawnCaptureCommand !== "function") {
    throw new Error("pi's package manager changed: cannot keep its version lookups out of the project folder");
  }
  host.spawnCaptureCommand = function (command, args, commandOptions) {
    return spawnCaptureCommand.call(this, command, args, isNpmVersionLookup(args)
      ? { ...commandOptions, cwd: npmLookupFolder(options.agentDir) }
      : commandOptions);
  };
  return manager;
}
