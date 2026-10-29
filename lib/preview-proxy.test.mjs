import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { connect } from "node:net";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { createPreviewProxy, readPreviewProxyConfig } = await jiti.import("./preview-proxy.ts");
const { parsePreviewTarget, previewFrameUrl } = await jiti.import("./preview-target.ts");
const { createWebSessionToken } = await jiti.import("./web-auth.ts");

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

function send(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, headers }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
      res.on("close", () => { if (!res.complete) reject(new Error("response cut off")); });
    });
    req.on("error", reject);
    req.end();
  });
}

async function setup(t) {
  const seen = [];
  const upstream = createServer((req, res) => {
    seen.push(req.headers);
    if (req.url === "/admin/page") {
      res.writeHead(302, { location: "login" });
      return res.end();
    }
    if (req.url === "/truncated") {
      res.writeHead(200, { "content-length": "100" });
      res.write("partial");
      return setTimeout(() => res.socket.destroy(), 20);
    }
    if (req.url === "/cached") {
      res.writeHead(200, { "cache-control": "max-age=60" });
      return res.end("cached");
    }
    if (req.url === "/redirect") {
      res.writeHead(302, { location: `http://localhost:${upstreamPort}//evil.example/next` });
      return res.end();
    }
    res.writeHead(200, {
      "x-frame-options": "DENY",
      "content-security-policy": "default-src 'self'; frame-ancestors 'none'",
      "set-cookie": ["app=1; Path=/", "pi_web_session=forged; Path=/"],
    });
    res.end(`path=${req.url}`);
  });
  upstream.on("upgrade", (req, socket) => {
    socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: echo\r\nConnection: Upgrade\r\nSet-Cookie: pi_web_session=forged\r\nSet-Cookie: app=1\r\n\r\n");
    socket.pipe(socket);
  });
  const upstreamPort = await listen(upstream);
  const proxy = createPreviewProxy();
  const proxyPort = await listen(proxy);
  t.after(() => {
    proxy.close();
    proxy.destroySockets();
    upstream.close();
    upstream.closeAllConnections();
  });
  return { seen, upstreamPort, proxyPort, proxy };
}

test("parses only local addresses", () => {
  assert.equal(parsePreviewTarget("5173")?.href, "http://localhost:5173/");
  assert.equal(parsePreviewTarget(" localhost:5173/a?b=1 ")?.href, "http://localhost:5173/a?b=1");
  assert.equal(parsePreviewTarget("http://0.0.0.0:8000/")?.href, "http://127.0.0.1:8000/");
  assert.equal(parsePreviewTarget("https://user:pw@127.0.0.2:3000")?.href, "https://127.0.0.2:3000/");
  assert.equal(parsePreviewTarget("http://[::1]:3000")?.href, "http://[::1]:3000/");
  for (const input of ["", "example.com", "http://192.168.1.2:3000", "file:///etc/passwd", "http://localhost.evil.example/"]) {
    assert.equal(parsePreviewTarget(input), null, input);
  }
});

test("frames directly on the Pi Web machine, through the proxy elsewhere", () => {
  const target = parsePreviewTarget("localhost:5173/x");
  assert.equal(previewFrameUrl(target, "127.0.0.1", null), "http://localhost:5173/x");
  assert.equal(previewFrameUrl(target, "nuc.example", "https://nuc.example:10454"), "https://nuc.example:10454/__pi_web_preview?target=http%3A%2F%2Flocalhost%3A5173%2Fx");
  assert.equal(previewFrameUrl(target, "nuc.example", null), null);
  assert.match(previewFrameUrl(target, "nuc.example", "https://nuc.example:10454", true), /&hard=1$/);
  assert.equal(previewFrameUrl(target, "localhost", "https://nuc.example:10454", true), "http://localhost:5173/x");
});

test("reads the proxy config only with a valid port", () => {
  assert.equal(readPreviewProxyConfig({}), null);
  assert.equal(readPreviewProxyConfig({ PI_WEB_PREVIEW_PORT: "70000" }), null);
  assert.deepEqual(readPreviewProxyConfig({ PI_WEB_PREVIEW_PORT: "30144", PI_WEB_PREVIEW_URL: "https://nuc.example:10454/x" }), { port: 30144, url: "https://nuc.example:10454" });
  assert.deepEqual(readPreviewProxyConfig({ PI_WEB_PREVIEW_PORT: "30144", PI_WEB_PREVIEW_URL: "javascript:alert(1)" }), { port: 30144, url: null });
});

test("selects a local target, forwards requests, and cleans both directions", async (t) => {
  const { seen, upstreamPort, proxyPort } = await setup(t);
  assert.equal((await send(proxyPort, "/")).status, 404);
  assert.equal((await send(proxyPort, `/__pi_web_preview?target=${encodeURIComponent("http://example.com/")}`)).status, 400);
  assert.equal((await send(proxyPort, `/__pi_web_preview?target=${encodeURIComponent(`http://127.0.0.1:${proxyPort}/`)}`)).status, 400, "the proxy cannot target itself");

  const entry = await send(proxyPort, `/__pi_web_preview?target=${encodeURIComponent(`http://localhost:${upstreamPort}//evil.example/a?b=1`)}`);
  assert.equal(entry.status, 302);
  assert.equal(entry.headers.location, "/evil.example/a?b=1");

  const page = await send(proxyPort, "/a?b=1", {
    cookie: "pi_web_session=secret; app=1",
    origin: `http://127.0.0.1:${proxyPort}`,
  });
  assert.equal(page.status, 200);
  assert.equal(page.body, "path=/a?b=1");
  assert.equal(page.headers["x-frame-options"], undefined);
  assert.equal(page.headers["content-security-policy"], "default-src 'self';");
  assert.deepEqual(page.headers["set-cookie"], ["app=1; Path=/"]);
  assert.equal(seen.at(-1).host, `localhost:${upstreamPort}`);
  assert.equal(seen.at(-1).cookie, "app=1");
  assert.equal(seen.at(-1).origin, `http://localhost:${upstreamPort}`);
  assert.equal((await send(proxyPort, "/admin/page")).headers.location, "/admin/login");

  assert.equal((await send(proxyPort, "/redirect")).headers.location, "/evil.example/next");
  assert.equal(page.headers["cache-control"], "no-cache", "no rules: revalidate instead of a guessed lifetime");
  assert.equal((await send(proxyPort, "/cached")).headers["cache-control"], "max-age=60");

  assert.equal(entry.headers["clear-site-data"], undefined);
  const hard = await send(proxyPort, `/__pi_web_preview?target=${upstreamPort}&hard=1`);
  assert.equal(hard.status, 302);
  assert.equal(hard.headers["clear-site-data"], '"cache"');
});

test("refuses untrusted hosts, other sites, and missing sign-in", async (t) => {
  const { upstreamPort, proxyPort } = await setup(t);
  await send(proxyPort, `/__pi_web_preview?target=${upstreamPort}`);
  assert.equal((await send(proxyPort, "/", { host: "attacker.example" })).status, 403);
  assert.equal((await send(proxyPort, "/", { "sec-fetch-site": "cross-site" })).status, 403);
  assert.equal((await send(proxyPort, "/", { origin: "https://other.example" })).status, 403);
  assert.equal((await send(proxyPort, "/", { origin: "null" })).status, 403);

  const password = process.env.PI_WEB_PASSWORD;
  process.env.PI_WEB_PASSWORD = "pw";
  t.after(() => {
    if (password === undefined) delete process.env.PI_WEB_PASSWORD;
    else process.env.PI_WEB_PASSWORD = password;
  });
  assert.equal((await send(proxyPort, "/")).status, 403);
  assert.equal((await send(proxyPort, "/", { cookie: `pi_web_session=${createWebSessionToken("pw")}` })).status, 200);
});

test("relays upgraded connections and reports an unreachable service", async (t) => {
  const { upstreamPort, proxyPort } = await setup(t);
  await send(proxyPort, `/__pi_web_preview?target=${upstreamPort}`);
  const echoed = await new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: proxyPort, path: "/ws", headers: { connection: "Upgrade", upgrade: "echo" } });
    req.on("upgrade", (res, socket) => {
      assert.equal(res.statusCode, 101);
      assert.deepEqual(res.headers["set-cookie"], ["app=1"]);
      socket.once("data", (data) => { resolve(data.toString()); socket.destroy(); });
      socket.write("ping");
    });
    req.on("response", () => reject(new Error("upgrade refused")));
    req.on("error", reject);
    req.end();
  });
  assert.equal(echoed, "ping");

  const probe = createServer();
  const freePort = await listen(probe);
  await new Promise((resolve) => probe.close(resolve));
  await send(proxyPort, `/__pi_web_preview?target=${freePort}`);
  const down = await send(proxyPort, "/");
  assert.equal(down.status, 502);
  assert.match(down.body, /Cannot reach/);
});

test("survives a malformed request URL and ends cut-off responses", async (t) => {
  const { upstreamPort, proxyPort } = await setup(t);
  const status = await new Promise((resolve, reject) => {
    const socket = connect(proxyPort, "127.0.0.1", () => socket.write("GET //[ HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n"));
    let data = "";
    socket.on("data", (chunk) => { data += chunk; });
    socket.on("end", () => resolve(data.split(" ")[1]));
    socket.on("error", reject);
  });
  assert.equal(status, "400");

  await send(proxyPort, `/__pi_web_preview?target=${upstreamPort}`);
  const outcome = await Promise.race([
    send(proxyPort, "/truncated").then(() => "completed", () => "closed"),
    new Promise((resolve) => setTimeout(() => resolve("hung"), 2000)),
  ]);
  assert.equal(outcome, "closed");
});
