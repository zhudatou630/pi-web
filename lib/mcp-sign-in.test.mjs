import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { runMcpSignIn, pasteMcpRedirect, signOutMcpServer } = await jiti.import("./mcp-sign-in.ts");
const { readMcpSettings } = await jiti.import("./mcp-config.ts");

/** An OAuth-protected streamable HTTP MCP server that is its own authorization server (DCR + PKCE). */
async function startOAuthServer() {
  const access = new Set();
  const codes = new Map();
  let origin;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, origin);
    let body = "";
    for await (const chunk of req) body += chunk;
    const json = (status, value, headers = {}) => res.writeHead(status, { "Content-Type": "application/json", ...headers }).end(JSON.stringify(value));
    if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) return json(200, { resource: `${origin}/mcp`, authorization_servers: [origin] });
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      return json(200, {
        issuer: origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`,
        registration_endpoint: `${origin}/register`, response_types_supported: ["code"],
        code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"],
      });
    }
    if (url.pathname === "/register") return json(201, { client_id: randomUUID(), redirect_uris: JSON.parse(body).redirect_uris, token_endpoint_auth_method: "none" });
    if (url.pathname === "/authorize") {
      // Approves at once: the redirect is what a browser would follow.
      const code = randomUUID();
      codes.set(code, url.searchParams.get("code_challenge"));
      const target = new URL(url.searchParams.get("redirect_uri"));
      target.searchParams.set("code", code);
      target.searchParams.set("state", url.searchParams.get("state"));
      return res.writeHead(302, { Location: target.href }).end();
    }
    if (url.pathname === "/token") {
      const params = new URLSearchParams(body);
      const challenge = codes.get(params.get("code"));
      if (createHash("sha256").update(params.get("code_verifier") ?? "").digest("base64url") !== challenge) return json(400, { error: "invalid_grant" });
      const token = randomUUID();
      access.add(token);
      return json(200, { access_token: token, token_type: "Bearer", expires_in: 3600 });
    }
    if (!access.has(req.headers.authorization?.replace(/^Bearer /, ""))) {
      return json(401, { error: "unauthorized" }, { "WWW-Authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"` });
    }
    if (req.method !== "POST") return res.writeHead(405).end();
    const message = JSON.parse(body);
    if (message.id === undefined) return res.writeHead(202).end();
    const result = message.method === "initialize"
      ? { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "oauth", version: "1" } }
      : { tools: [{ name: "whoami", inputSchema: { type: "object" } }] };
    return json(200, { jsonrpc: "2.0", id: message.id, result });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  return { url: `${origin}/mcp`, close: () => { server.closeAllConnections(); server.close(); } };
}

const root = mkdtempSync(join(tmpdir(), "pi-web-mcp-sign-in-"));
const agentDir = join(root, "agent");
mkdirSync(agentDir);
const oauth = await startOAuthServer();
after(() => { oauth.close(); rmSync(root, { recursive: true, force: true }); });
// Accepts connections and never answers: a sign-in stuck while connecting.
const silent = createServer(() => {});
await new Promise((resolve) => silent.listen(0, "127.0.0.1", resolve));
after(() => { silent.closeAllConnections(); silent.close(); });
writeFileSync(join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: {
  docs: { url: oauth.url },
  plain: { url: oauth.url, headers: { Authorization: "Bearer x" } },
  stuck: { url: `http://127.0.0.1:${silent.address().port}/mcp` },
} }));

/** Runs a sign-in; `onAuth` acts as the browser once the authorization URL is shown. */
async function signIn(onAuth, signal = new AbortController().signal) {
  const events = [];
  await runMcpSignIn({ cwd: null, name: "docs", signal, emit: (event) => {
    events.push(event);
    if (event.type === "auth") void onAuth(event);
  } }, agentDir);
  return events;
}
const approve = async (url) => (await fetch(url, { redirect: "manual" })).headers.get("location");

test("a remote browser pastes the redirected address; a bad paste leaves the flow waiting", async () => {
  const events = await signIn(async ({ url, token }) => {
    const redirected = await approve(url);
    assert.equal(pasteMcpRedirect(token, "https://example.com/callback?code=x&state=y"), "invalid");
    assert.equal(pasteMcpRedirect(token, redirected.replace(/state=[^&]+/, "state=other")), "invalid");
    assert.equal(pasteMcpRedirect(token, redirected), "ok");
  });
  assert.deepEqual(events.map((event) => event.type), ["auth", "finishing", "success"]);
  assert.equal(events.at(-1).tools, 1);
  const listed = await readMcpSettings(null, agentDir);
  assert.equal(listed.servers.find((server) => server.name === "docs").signedIn, true);
  assert.equal(listed.servers.find((server) => server.name === "plain").usesOAuth, false);
});

test("an already signed-in server needs no page; sign-out deletes the credentials", async () => {
  const events = await signIn(() => assert.fail("no sign-in page expected"));
  assert.deepEqual(events, [{ type: "success", tools: 1, already: true }]);
  assert.equal(await signOutMcpServer({ cwd: null, name: "docs" }, agentDir), true);
  assert.equal(await signOutMcpServer({ cwd: null, name: "docs" }, agentDir), false);
  assert.equal((await readMcpSettings(null, agentDir)).servers.find((server) => server.name === "docs").signedIn, false);
});

test("a local browser completes through the loopback callback; a second flow is refused", async () => {
  const events = await signIn(async ({ url }) => {
    await assert.rejects(runMcpSignIn({ cwd: null, name: "docs", signal: new AbortController().signal, emit: () => {} }, agentDir), /already running/);
    await fetch(await approve(url));
  });
  assert.equal(events.at(-1).type, "success");
});

test("closing the stream cancels a waiting sign-in; servers without OAuth are refused", async () => {
  await signOutMcpServer({ cwd: null, name: "docs" }, agentDir);
  const controller = new AbortController();
  const events = await signIn(() => controller.abort(), controller.signal);
  assert.equal(events.at(-1).type, "cancelled");
  await assert.rejects(signOutMcpServer({ cwd: null, name: "plain" }, agentDir), /does not sign in with OAuth/);
});

test("closing the stream while connecting cancels at once and frees the flow", async () => {
  const run = (signal) => {
    const events = [];
    return runMcpSignIn({ cwd: null, name: "stuck", signal, emit: (event) => events.push(event) }, agentDir).then(() => events);
  };
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 200);
  const start = Date.now();
  assert.deepEqual(await run(controller.signal), [{ type: "cancelled" }]);
  assert.ok(Date.now() - start < 3000, "must not wait for the connect timeout");
  // The flow was released: a new attempt is not refused as already running.
  assert.deepEqual(await run(AbortSignal.abort()), [{ type: "cancelled" }]);
});
