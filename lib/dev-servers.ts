import { execFile } from "node:child_process";
import { readlink } from "node:fs/promises";
import http from "node:http";
import { promisify } from "node:util";
import { isPathWithinRoots } from "./path-security";

const execFileAsync = promisify(execFile);

export interface Listener {
  /** Loopback host that reaches the socket: `127.0.0.1`-style or `[::1]`. */
  host: string;
  port: number;
  pid: number | null;
  process: string | null;
}

export interface DevServer {
  url: string;
  port: number;
  process: string | null;
  cwd: string | null;
  /** The server process runs inside the asking session's directory. */
  inCwd: boolean;
}

/** `127.0.0.1:3000`, `*:3000`, `[::]:3000` → a loopback host/port to reach it; null for other interfaces. */
export function loopbackAddress(address: string): { host: string; port: number } | null {
  const colon = address.lastIndexOf(":");
  const host = address.slice(0, colon).replace(/^\[(.*)\]$/, "$1");
  const port = Number(address.slice(colon + 1));
  if (colon < 0 || !Number.isInteger(port) || port <= 0 || port > 65535) return null;
  if (host === "*" || host === "0.0.0.0") return { host: "127.0.0.1", port };
  if (/^127\.\d+\.\d+\.\d+$/.test(host)) return { host, port };
  if (host === "::" || host === "::1") return { host: "[::1]", port };
  return null;
}

/** Linux `ss -ltnpH`: pid and name only for processes this user may inspect. */
export function parseSs(stdout: string): Listener[] {
  const listeners: Listener[] = [];
  for (const line of stdout.split("\n")) {
    const address = loopbackAddress(line.trim().split(/\s+/)[3] ?? "");
    if (!address) continue;
    const owner = line.match(/users:\(\("((?:[^"\\]|\\.)*)",pid=(\d+)/);
    listeners.push({ ...address, pid: owner ? Number(owner[2]) : null, process: owner ? owner[1] : null });
  }
  return listeners;
}

/** macOS `lsof -nP -iTCP -sTCP:LISTEN -Fpcnt`: `p<pid>`/`c<command>` precede the process's sockets, `t<type>` precedes each `n<address>`. */
export function parseLsof(stdout: string): Listener[] {
  const listeners: Listener[] = [];
  let pid: number | null = null;
  let command: string | null = null;
  let type = "";
  for (const line of stdout.split("\n")) {
    if (line.startsWith("p")) { pid = Number(line.slice(1)); command = null; }
    else if (line.startsWith("c")) command = line.slice(1);
    else if (line.startsWith("t")) type = line.slice(1);
    else if (line.startsWith("n")) {
      // lsof writes both wildcards as `*`; an IPv6 one may refuse 127.0.0.1.
      const name = type === "IPv6" && line.startsWith("n*:") ? `[::]${line.slice(2)}` : line.slice(1);
      const address = loopbackAddress(name);
      if (address) listeners.push({ ...address, pid, process: command });
    }
  }
  return listeners;
}

/** Windows `netstat -ano`. The state column is localized, so a listening socket is recognized by its `:0` peer. */
export function parseNetstat(stdout: string): Listener[] {
  const listeners: Listener[] = [];
  for (const line of stdout.split("\n")) {
    const [proto, local, peer, , pid] = line.trim().split(/\s+/);
    if (!proto?.startsWith("TCP") || !peer?.endsWith(":0")) continue;
    const address = loopbackAddress(local ?? "");
    // shortcut: no process names or cwds on Windows (no cheap source), so nothing is sorted first there.
    if (address) listeners.push({ ...address, pid: Number(pid) || null, process: null });
  }
  return listeners;
}

/** lsof exits 1 when some pid or socket was not found, but its output is still valid. */
async function lsof(args: string[]): Promise<string> {
  try {
    return (await execFileAsync("lsof", args, { timeout: 5000 })).stdout;
  } catch (error) {
    const stdout = (error as { stdout?: unknown }).stdout;
    if ((error as { code?: unknown }).code === 1 && typeof stdout === "string") return stdout;
    throw error;
  }
}

async function readListeners(): Promise<Listener[]> {
  if (process.platform === "linux") return parseSs((await execFileAsync("ss", ["-ltnpH"], { timeout: 5000 })).stdout);
  if (process.platform === "darwin") return parseLsof(await lsof(["-nP", "-iTCP", "-sTCP:LISTEN", "-Fpcnt"]));
  if (process.platform === "win32") return parseNetstat((await execFileAsync("netstat", ["-ano"], { timeout: 5000 })).stdout);
  return [];
}

async function processCwds(pids: number[]): Promise<Map<number, string>> {
  const cwds = new Map<number, string>();
  if (!pids.length) return cwds;
  if (process.platform === "linux") {
    await Promise.all(pids.map(async (pid) => {
      try { cwds.set(pid, await readlink(`/proc/${pid}/cwd`)); } catch { /* exited, or another user's */ }
    }));
  } else if (process.platform === "darwin") {
    let pid: number | null = null;
    for (const line of (await lsof(["-a", "-d", "cwd", "-p", pids.join(","), "-Fn"])).split("\n")) {
      if (line.startsWith("p")) pid = Number(line.slice(1));
      else if (line.startsWith("n") && pid !== null) cwds.set(pid, line.slice(1));
    }
  }
  return cwds;
}

/** Any HTTP response counts; databases and other protocols time out or close. */
function respondsToHttp(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    // shortcut: HTTPS-only servers usually close a plain request and are not listed; add a TLS probe if they matter.
    const request = http.request({ host: host.replace(/^\[(.*)\]$/, "$1"), port, method: "HEAD", path: "/", timeout: 1500, agent: false }, (response) => {
      response.resume();
      resolve(true);
      request.destroy();
    });
    request.on("timeout", () => request.destroy());
    request.on("error", () => resolve(false));
    request.end();
  });
}

/** Local HTTP services, the ones running inside `sessionCwd` first. */
export async function listDevServers(sessionCwd: string | null): Promise<DevServer[]> {
  const bySocket = new Map<string, Listener>();
  for (const listener of await readListeners()) {
    // One process may list a socket per address family; IPv4 gives the plainer address.
    const key = `${listener.port}:${listener.pid}`;
    const previous = bySocket.get(key);
    if (!previous || (previous.host.startsWith("[") && !listener.host.startsWith("["))) bySocket.set(key, listener);
  }
  const listeners = [...bySocket.values()];
  const [cwds, isHttp] = await Promise.all([
    processCwds([...new Set(listeners.flatMap((listener) => listener.pid ?? []))]),
    Promise.all(listeners.map((listener) => respondsToHttp(listener.host, listener.port))),
  ]);
  const roots = new Set(sessionCwd ? [sessionCwd] : []);
  return listeners
    .filter((_, index) => isHttp[index])
    .map((listener) => {
      const cwd = listener.pid === null ? null : cwds.get(listener.pid) ?? null;
      return {
        url: `http://${listener.host}:${listener.port}`,
        port: listener.port,
        process: listener.process,
        cwd,
        inCwd: cwd !== null && isPathWithinRoots(cwd, roots),
      };
    })
    .sort((a, b) => Number(b.inCwd) - Number(a.inCwd) || a.port - b.port)
    // Worker processes sharing one socket (gunicorn, SO_REUSEPORT) are one server.
    .filter((server, index, all) => all.findIndex((other) => other.url === server.url) === index);
}
