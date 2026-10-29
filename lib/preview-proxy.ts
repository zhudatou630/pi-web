import { createServer, request as httpRequest, type IncomingMessage, type OutgoingHttpHeaders, type Server, type ServerResponse } from "node:http";
import { request as httpsRequest, type RequestOptions } from "node:https";
import type { AddressInfo, Socket } from "node:net";
import { PREVIEW_ENTRY_PATH, parsePreviewTarget } from "./preview-target";
import { isHostHeaderAllowed } from "./request-security";
import { isValidWebSessionToken, isWebPasswordEnabled, PI_WEB_SESSION_COOKIE } from "./web-auth";

/*
 * Local-service preview: lets a remote browser open the Pi Web machine's
 * `localhost:<port>` services. It listens on its own port so previewed pages get
 * an origin apart from Pi Web's. Design: docs/preview.md.
 */

export interface PreviewProxyConfig {
  port: number;
  /** External origin browsers use to reach `port`, e.g. a `tailscale serve` HTTPS port. */
  url: string | null;
}

export function readPreviewProxyConfig(env: NodeJS.ProcessEnv = process.env): PreviewProxyConfig | null {
  const rawPort = env.PI_WEB_PREVIEW_PORT?.trim();
  if (!rawPort) return null;
  const port = Number(rawPort);
  if (!/^\d+$/.test(rawPort) || port < 1 || port > 65535) return null;
  let url: string | null = null;
  try {
    const parsed = new URL(env.PI_WEB_PREVIEW_URL?.trim() ?? "");
    if (parsed.protocol === "http:" || parsed.protocol === "https:") url = parsed.origin;
  } catch { /* unset or invalid: only a browser on this machine can use the preview */ }
  return { port, url };
}

function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of header?.split(";") ?? []) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return value.join("=");
  }
  return undefined;
}

function hostnameOf(authority: string | undefined): string | null {
  try {
    return authority ? new URL(`http://${authority}`).hostname : null;
  } catch {
    return null;
  }
}

/** Why a request may not use the proxy, or null. */
export function previewRejection(req: IncomingMessage, password = process.env.PI_WEB_PASSWORD): string | null {
  const host = req.headers.host;
  if (!isHostHeaderAllowed(host)) return "Untrusted host. Add it to PI_WEB_ALLOWED_HOSTS.";
  // Pages of other sites (or other hosts of a shared parent domain) must not drive local services.
  if (req.headers["sec-fetch-site"] === "cross-site") return "Cross-site request refused.";
  const origin = req.headers.origin;
  if (origin) {
    let originHostname: string | null = null;
    try { originHostname = new URL(origin).hostname; } catch { /* "null" or malformed */ }
    if (originHostname !== hostnameOf(host)) return "Foreign origin refused.";
  }
  if (isWebPasswordEnabled(password) && !isValidWebSessionToken(readCookie(req.headers.cookie, PI_WEB_SESSION_COOKIE), password)) {
    return "Sign in to Pi Web first, then open the preview again.";
  }
  return null;
}

function portOf(url: URL): number {
  return Number(url.port || (url.protocol === "https:" ? 443 : 80));
}

/** Path the browser should follow for an upstream redirect into the previewed service. */
function previewLocation(location: string, target: URL): string {
  let url: URL;
  try {
    url = new URL(location, target);
  } catch {
    return location;
  }
  const local = parsePreviewTarget(url.href);
  if (!local || portOf(local) !== portOf(target)) return location;
  // A leading "//" would make the browser treat the path as another host.
  return `/${url.pathname.replace(/^\/+/, "")}${url.search}${url.hash}`;
}

function upstreamHeaders(req: IncomingMessage, target: URL): OutgoingHttpHeaders {
  const headers: OutgoingHttpHeaders = { ...req.headers, host: target.host };
  // Pi Web's session is not the previewed service's business.
  const cookie = req.headers.cookie?.split(";").filter((part) => !part.trim().startsWith(`${PI_WEB_SESSION_COOKIE}=`)).join(";").trim();
  if (cookie) headers.cookie = cookie;
  else delete headers.cookie;
  // previewRejection() admitted only this host's pages; dev servers check Origin against their own address (Vite's WebSocket, CSRF guards).
  if (req.headers.origin) headers.origin = target.origin;
  return headers;
}

function isSessionCookie(setCookie: string): boolean {
  return setCookie.trimStart().startsWith(`${PI_WEB_SESSION_COOKIE}=`);
}

/** `base`: the upstream URL that was requested, so relative redirects resolve like in the browser. */
function downstreamHeaders(res: IncomingMessage, base: URL): OutgoingHttpHeaders {
  const headers: OutgoingHttpHeaders = { ...res.headers };
  // Without caching rules browsers guess a lifetime, so edited CSS stays stale; revalidating costs a 304.
  if (!res.headers["cache-control"] && !res.headers.expires) headers["cache-control"] = "no-cache";
  delete headers.connection;
  delete headers["keep-alive"];
  // Pi Web shows the page in its own frame.
  delete headers["x-frame-options"];
  const csp = res.headers["content-security-policy"];
  if (typeof csp === "string") headers["content-security-policy"] = csp.replace(/(^|;)\s*frame-ancestors[^;]*/gi, "$1");
  if (res.headers.location) headers.location = previewLocation(res.headers.location, base);
  const cookies = res.headers["set-cookie"];
  if (cookies) headers["set-cookie"] = cookies.filter((cookie) => !isSessionCookie(cookie));
  return headers;
}

function openUpstream(req: IncomingMessage, target: URL) {
  const options: RequestOptions = {
    host: target.hostname.replace(/^\[|\]$/g, ""),
    port: portOf(target),
    method: req.method,
    path: req.url,
    headers: upstreamHeaders(req, target),
    // Loopback only: a dev server's self-signed certificate is expected.
    rejectUnauthorized: false,
  };
  return target.protocol === "https:" ? httpsRequest(options) : httpRequest(options);
}

function sendText(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
  res.end(text);
}

type PreviewProxy = Server & { destroySockets(): void };

export function createPreviewProxy(): PreviewProxy {
  // shortcut: one previewed address per Pi Web server, shared by every browser; add slots if two are needed at once.
  let target: URL | null = null;
  const sockets = new Set<Socket>();

  const server = createServer((req, res) => {
    const rejection = previewRejection(req);
    if (rejection) return sendText(res, 403, rejection);

    let url: URL;
    try {
      url = new URL(req.url ?? "/", "http://preview.invalid");
    } catch {
      return sendText(res, 400, "Bad request URL.");
    }
    if (url.pathname === PREVIEW_ENTRY_PATH) {
      const next = parsePreviewTarget(url.searchParams.get("target") ?? "");
      if (!next) return sendText(res, 400, "Only local addresses (localhost, 127.0.0.1) can be previewed.");
      if (portOf(next) === (server.address() as AddressInfo | null)?.port) return sendText(res, 400, "That is the preview proxy itself.");
      target = next;
      res.writeHead(302, {
        location: previewLocation(next.href, next),
        "cache-control": "no-store",
        // Hard reload: the browser drops this site's cached files before following the redirect.
        ...(url.searchParams.get("hard") === "1" ? { "clear-site-data": '"cache"' } : {}),
      });
      return res.end();
    }
    if (!target) return sendText(res, 404, "No preview address selected. Open one from Pi Web.");

    const current = target;
    const upstream = openUpstream(req, current);
    upstream.on("response", (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.statusMessage, downstreamHeaders(upstreamRes, new URL(url.pathname + url.search, current)));
      upstreamRes.pipe(res);
      // A cut-off body (service restarted mid-response) must not leave the browser waiting.
      upstreamRes.on("close", () => {
        if (!upstreamRes.complete) res.destroy();
      });
    });
    upstream.on("error", (error) => {
      if (res.headersSent) res.destroy();
      else sendText(res, 502, `Cannot reach ${current.origin}: ${error.message}. Is the service running?`);
    });
    res.on("close", () => {
      if (!res.writableFinished) upstream.destroy();
    });
    req.pipe(upstream);
  });

  // WebSocket (dev-server hot reload): relay the handshake, then the raw bytes.
  server.on("upgrade", (req: IncomingMessage, socket: Socket, head: Buffer) => {
    socket.on("error", () => socket.destroy());
    if (previewRejection(req) || !target) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }
    const upstream = openUpstream(req, target);
    upstream.on("upgrade", (upstreamRes, upstreamSocket, upstreamHead) => {
      const lines = [`HTTP/1.1 101 ${upstreamRes.statusMessage || "Switching Protocols"}`];
      for (let i = 0; i < upstreamRes.rawHeaders.length; i += 2) {
        const [name, value] = [upstreamRes.rawHeaders[i], upstreamRes.rawHeaders[i + 1]];
        if (name.toLowerCase() !== "set-cookie" || !isSessionCookie(value)) lines.push(`${name}: ${value}`);
      }
      socket.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (upstreamHead.length) socket.write(upstreamHead);
      if (head.length) upstreamSocket.write(head);
      upstreamSocket.on("error", () => socket.destroy());
      upstreamSocket.on("close", () => socket.destroy());
      socket.on("close", () => upstreamSocket.destroy());
      upstreamSocket.pipe(socket).pipe(upstreamSocket);
    });
    upstream.on("response", (upstreamRes) => {
      upstreamRes.resume();
      socket.end(`HTTP/1.1 ${upstreamRes.statusCode} ${upstreamRes.statusMessage}\r\nConnection: close\r\n\r\n`);
    });
    upstream.on("error", () => socket.destroy());
    socket.on("close", () => upstream.destroy());
    upstream.end();
  });

  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  // close() alone waits for open sockets, and upgraded ones are invisible to closeAllConnections().
  return Object.assign(server, { destroySockets: () => sockets.forEach((socket) => socket.destroy()) });
}

const PREVIEW_SERVER_KEY = Symbol.for("@calmabacus/pi-web/preview-proxy/v1");

/** Starts the proxy once per process when PI_WEB_PREVIEW_PORT is set. */
export function startPreviewProxy(env: NodeJS.ProcessEnv = process.env): void {
  const host = globalThis as unknown as Record<symbol, PreviewProxy | undefined>;
  if (host[PREVIEW_SERVER_KEY] || !env.PI_WEB_PREVIEW_PORT?.trim()) return;
  const config = readPreviewProxyConfig(env);
  if (!config) {
    console.error(`[pi-web] ignoring invalid PI_WEB_PREVIEW_PORT=${env.PI_WEB_PREVIEW_PORT}`);
    return;
  }
  const server = createPreviewProxy();
  host[PREVIEW_SERVER_KEY] = server;
  server.on("error", (error) => console.error(`[pi-web] preview proxy cannot listen on 127.0.0.1:${config.port}: ${error.message}`));
  // shortcut: loopback only, reached through a local reverse proxy (tailscale serve); bind elsewhere if LAN access is needed.
  server.listen(config.port, "127.0.0.1", () => console.log(`[pi-web] local-service preview proxy on 127.0.0.1:${config.port}`));
}

export function stopPreviewProxy(): void {
  const server = (globalThis as unknown as Record<symbol, PreviewProxy | undefined>)[PREVIEW_SERVER_KEY];
  server?.close();
  server?.destroySockets();
}
