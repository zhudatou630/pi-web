/**
 * Last GET reply per settings URL, so a settings page paints its previous data at
 * once and then revalidates. Lives until the page reloads.
 */
export interface JsonReply<T> {
  ok: boolean;
  status: number;
  data: T;
}

const replies = new Map<string, JsonReply<unknown>>();
const pending = new Map<string, Promise<JsonReply<unknown>>>();

export function peekJson<T>(url: string): JsonReply<T> | undefined {
  return replies.get(url) as JsonReply<T> | undefined;
}

/** Fresh GET that also refreshes the cache. Joins a request already in flight.
    ponytail: a refresh right after a mutation can join a GET started before it; add a
    generation counter if that window ever shows stale data. */
export function getJson<T>(url: string): Promise<JsonReply<T>> {
  let request = pending.get(url);
  if (!request) {
    request = fetch(url, { cache: "no-store" })
      .then(async (response) => {
        const reply = { ok: response.ok, status: response.status, data: await response.json() as unknown };
        replies.set(url, reply);
        return reply;
      })
      .finally(() => pending.delete(url));
    pending.set(url, request);
  }
  return request as Promise<JsonReply<T>>;
}

const q = (cwd: string) => `cwd=${encodeURIComponent(cwd)}`;

export const settingsUrls = {
  webAuth: "/api/web-auth",
  toolSettings: "/api/tools/settings",
  modelsConfig: "/api/models-config",
  authProviders: (cwd: string | null) => `/api/auth/providers${cwd ? `?${q(cwd)}` : ""}`,
  modelsRuntime: (cwd: string) => `/api/models-config/runtime?${q(cwd)}`,
  modelsPicker: (cwd: string) => `/api/models-config/picker?${q(cwd)}`,
  subagentProfiles: (cwd: string) => `/api/subagents/profiles?${q(cwd)}`,
  subagentSettings: "/api/subagents/settings",
  chatModels: (cwd: string) => `/api/models?${q(cwd)}`,
  imageSettings: "/api/image-generation/settings",
  skills: (cwd: string) => `/api/skills?${q(cwd)}`,
  plugins: (cwd: string) => `/api/plugins?${q(cwd)}`,
  usage: "/api/usage",
};

/** Warms every settings page that has no data yet; pages revalidate when they mount.
    Models goes first: it is the slowest page and the browser runs ~6 requests at once. */
export function prefetchSettings(cwd: string | null): void {
  const u = settingsUrls;
  const urls = cwd
    ? [u.modelsConfig, u.authProviders(cwd), u.modelsRuntime(cwd), u.modelsPicker(cwd), u.webAuth, u.toolSettings,
      u.subagentSettings, u.subagentProfiles(cwd), u.chatModels(cwd), u.imageSettings, u.skills(cwd), u.plugins(cwd), u.usage]
    : [u.modelsConfig, u.authProviders(cwd), u.webAuth, u.toolSettings, u.subagentSettings, u.imageSettings, u.usage];
  for (const url of urls) if (!replies.has(url)) getJson(url).catch(() => {});
}

/** Refetches every cached reply when settings close, so edits made there are what
    the next open paints. */
export function revalidateSettings(): void {
  for (const url of replies.keys()) getJson(url).catch(() => {});
}
