import { gt, prerelease, valid } from "semver";

function isStableVersion(version: string): boolean {
  return valid(version) === version && prerelease(version) === null;
}

export function isNewerStableVersion(candidate: string, current: string): boolean {
  return isStableVersion(candidate) && isStableVersion(current) && gt(candidate, current);
}

export function getPiWebReleaseUrl(version: string): string | null {
  return isStableVersion(version)
    ? `https://github.com/agegr/pi-web/releases/tag/v${version}`
    : null;
}
