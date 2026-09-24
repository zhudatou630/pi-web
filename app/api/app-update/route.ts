import { after, NextResponse } from "next/server";
import type { AppUpdateResponse } from "@/lib/api-types";
import { getPiWebReleaseUrl, isNewerStableVersion } from "@/lib/app-update";

export const dynamic = "force-dynamic";

const CURRENT_VERSION = process.env.NEXT_PUBLIC_APP_VERSION ?? "0.0.0";
const NPM_LATEST_URL = "https://registry.npmjs.org/@calmabacus%2Fpi-web/latest";
const CACHE_TTL_MS = 30 * 60 * 1000;
const FETCH_TIMEOUT_MS = 5_000;
const SKIP_VERSION_CHECK = process.env.PI_WEB_SKIP_VERSION_CHECK === "1";
const CAN_UPDATE = process.env.PI_WEB_CAN_UPDATE === "1" && typeof process.send === "function";

// Mirror of the launcher's PI_WEB_UPDATE_BLOCKED reasons (bin/app-update.js).
const MANUAL_COMMANDS: Record<string, string> = {
  readonly: "sudo npm install -g @calmabacus/pi-web@latest",
};

function updateResponse(value: AppUpdateResponse) {
  const manualCommand = MANUAL_COMMANDS[process.env.PI_WEB_UPDATE_BLOCKED ?? ""];
  return NextResponse.json({
    ...value,
    canUpdate: CAN_UPDATE,
    ...(manualCommand ? { manualCommand } : {}),
  }, {
    headers: { "Cache-Control": "no-store" },
  });
}

interface AppUpdateCache {
  value?: AppUpdateResponse;
  expiresAt: number;
  inFlight?: Promise<AppUpdateResponse>;
}

declare global {
  var __piWebAppUpdateCache: AppUpdateCache | undefined;
}

function getCache(): AppUpdateCache {
  return globalThis.__piWebAppUpdateCache ??= { expiresAt: 0 };
}

async function fetchLatestVersion(): Promise<AppUpdateResponse> {
  const response = await fetch(NPM_LATEST_URL, {
    cache: "no-store",
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`npm registry returned HTTP ${response.status}`);

  const body = await response.json() as { version?: unknown };
  const latestVersion = typeof body.version === "string" ? body.version : "";
  const releaseUrl = getPiWebReleaseUrl(latestVersion);
  if (!releaseUrl) throw new Error("npm registry returned an invalid version");

  return {
    currentVersion: CURRENT_VERSION,
    latestVersion,
    updateAvailable: isNewerStableVersion(latestVersion, CURRENT_VERSION),
    releaseUrl,
  };
}

// force: manual check — bypass the cache and surface failures instead of stale data.
async function loadUpdateStatus(force: boolean): Promise<AppUpdateResponse> {
  const cache = getCache();
  if (!force && cache.value && cache.expiresAt > Date.now()) return cache.value;
  if (!cache.inFlight) {
    cache.inFlight = fetchLatestVersion().then((value) => {
      cache.value = value;
      cache.expiresAt = Date.now() + CACHE_TTL_MS;
      return value;
    }).finally(() => {
      cache.inFlight = undefined;
    });
  }

  try {
    return await cache.inFlight;
  } catch (error) {
    if (!force && cache.value) return cache.value;
    throw error;
  }
}

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  if (SKIP_VERSION_CHECK || params.get("status") === "1") {
    return updateResponse({
      currentVersion: CURRENT_VERSION,
      latestVersion: CURRENT_VERSION,
      updateAvailable: false,
      releaseUrl: "",
    } satisfies AppUpdateResponse);
  }
  try {
    return updateResponse(await loadUpdateStatus(params.get("force") === "1"));
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 502 },
    );
  }
}

export async function POST() {
  if (!CAN_UPDATE || !process.connected) {
    return NextResponse.json({ error: "Use a writable npm global installation started with pi-web to update here." }, { status: 409 });
  }
  const [{ hasAppUpdateBlockingSessions }, { hasAppUpdateBlockingTerminals }] = await Promise.all([
    import("@/lib/rpc-manager"),
    import("@/lib/terminal-manager"),
  ]);
  if (globalThis.__piWebUpdating) {
    return NextResponse.json({ error: "Pi Web is already updating." }, { status: 409 });
  }
  if (hasAppUpdateBlockingSessions() || hasAppUpdateBlockingTerminals()) {
    return NextResponse.json({ error: "Finish running Agent tasks and close terminal sessions before updating." }, { status: 409 });
  }
  // No await between checking active work and blocking new work.
  globalThis.__piWebUpdating = true;
  after(() => {
    process.send!({ type: "pi-web:update" }, (error: Error | null) => {
      if (error) {
        globalThis.__piWebUpdating = false;
        console.error("[pi-web] Could not request update:", error);
      }
    });
  });
  return NextResponse.json({ updating: true }, { status: 202 });
}
