import assert from "node:assert/strict";
import test, { after, before, beforeEach } from "node:test";
import { createJiti } from "jiti";
import { NextRequest } from "next/server.js";

const originalPassword = process.env.PI_WEB_PASSWORD;
const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { proxy } = await jiti.import("../proxy.ts");
const { createWebSessionToken } = await jiti.import("./web-auth.ts");
const { getAuthRetryAfterMs, recordAuthFailure, recordAuthSuccess } = await import("./web-auth-throttle.ts");
const { GET, POST } = await jiti.import("../app/api/web-auth/route.ts");

beforeEach(() => recordAuthSuccess());

before(() => { process.env.PI_WEB_PASSWORD = "secret"; });
after(() => {
  recordAuthSuccess();
  if (originalPassword === undefined) delete process.env.PI_WEB_PASSWORD;
  else process.env.PI_WEB_PASSWORD = originalPassword;
});

function request(path, headers = {}) {
  return new NextRequest(`http://localhost${path}`, {
    headers: { Host: "localhost", ...headers },
  });
}

test("redirects page navigation to the login page and preserves its query", () => {
  const response = proxy(request("/?session=abc"));
  assert.equal(response.status, 307);
  assert.equal(response.headers.get("location"), "http://localhost/login?next=%2F%3Fsession%3Dabc");
});

test("accepts a signed session for pages", () => {
  const token = createWebSessionToken("secret");
  const response = proxy(request("/", { Cookie: `pi_web_session=${token}` }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-middleware-next"), "1");
});

test("keeps Basic Auth compatibility for APIs but not pages", () => {
  const authorization = `Basic ${Buffer.from("pi:secret").toString("base64")}`;
  assert.equal(proxy(request("/api/sessions", { Authorization: authorization })).status, 200);
  assert.equal(proxy(request("/", { Authorization: authorization })).status, 307);
  assert.equal(proxy(request("/api/sessions")).status, 401);
});

test("leaves the login endpoint reachable without a session", () => {
  assert.equal(proxy(request("/login")).status, 200);
  assert.equal(proxy(request("/api/web-auth")).status, 200);
});

function basic(password) {
  return `Basic ${Buffer.from(`pi:${password}`).toString("base64")}`;
}
function login(password, cookie) {
  return new NextRequest("http://localhost/api/web-auth", {
    method: "POST",
    headers: { Host: "localhost", "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify({ password }),
  });
}

test("Basic and form failures block each other, including correct guesses and the GET oracle", async () => {
  assert.equal(proxy(request("/api/sessions", { Authorization: basic("guess") })).status, 401);
  assert.ok(getAuthRetryAfterMs() > 0);
  assert.equal((await POST(login("secret"))).status, 429);
  for (const path of ["/api/sessions", "/api/web-auth"]) {
    const response = proxy(request(path, { Authorization: basic("secret") }));
    assert.equal(response.status, 429);
    assert.equal(response.headers.get("retry-after"), "1");
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
  recordAuthSuccess();
  assert.equal((await POST(login("guess"))).status, 401);
  assert.equal(proxy(request("/api/web-auth", { Authorization: basic("secret") })).status, 429);
});

test("GET web-auth guesses pass through the proxy throttle", async () => {
  const first = request("/api/web-auth", { Authorization: basic("guess") });
  assert.equal(proxy(first).status, 200);
  assert.deepEqual(await (await GET(first)).json(), { enabled: true, authenticated: false });
  assert.ok(getAuthRetryAfterMs() > 0);
  assert.equal(proxy(request("/api/web-auth", { Authorization: basic("guess-2") })).status, 429);
});

test("valid cookies bypass blocked guesses for APIs, auth status and form login", async () => {
  recordAuthFailure();
  const cookie = `pi_web_session=${createWebSessionToken("secret")}`;
  for (const path of ["/", "/api/sessions", "/api/web-auth"]) {
    assert.equal(proxy(request(path, { Authorization: basic("guess"), Cookie: cookie })).status, 200);
  }
  assert.deepEqual(await (await GET(request("/api/web-auth", { Cookie: cookie }))).json(), { enabled: true, authenticated: true });
  assert.equal((await POST(login("secret", cookie))).status, 200);
});

test("non-Basic headers are not guesses and Basic success never resets earlier failures", () => {
  assert.equal(proxy(request("/api/sessions", { Authorization: "Bearer token" })).status, 401);
  assert.equal(getAuthRetryAfterMs(), 0);
  recordAuthFailure(Date.now() - 2_000);
  assert.equal(proxy(request("/api/sessions", { Authorization: basic("secret") })).status, 200);
  assert.equal(proxy(request("/api/sessions", { Authorization: basic("guess") })).status, 401);
  assert.ok(getAuthRetryAfterMs() > 1_000);
});

test("concurrent form guesses cannot pass the gate before the body is read", async () => {
  const responses = await Promise.all([POST(login("guess")), POST(login("secret"))]);
  assert.deepEqual(responses.map((response) => response.status), [401, 429]);
});
