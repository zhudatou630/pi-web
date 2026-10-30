import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { waitForPage } from "../bin/wait-for-page.js";
import { isHostHeaderAllowed } from "./request-security.ts";

async function serverFor(t, handler, hostname = "127.0.0.1") {
  const server = http.createServer(handler);
  server.listen(0, hostname);
  await once(server, "listening");
  t.after(() => new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  }));
  return server;
}

test("follows the login redirect and waits for the entire streamed page", async (t) => {
  const paths = [];
  let finish;
  const server = await serverFor(t, (request, response) => {
    assert.equal(request.method, "GET");
    assert.equal(isHostHeaderAllowed(request.headers.host, []), true);
    paths.push(request.url);
    if (request.url === "/") {
      response.writeHead(307, { Location: "/login" });
      response.end();
    } else {
      response.write("login shell");
      finish = () => response.end("full page");
    }
  });
  let served = false;
  const waiting = waitForPage(`http://0.0.0.0:${server.address().port}/`).then((result) => { served = true; return result; });
  while (!finish) await delay(5);
  assert.equal(served, false, "headers and the initial chunk are not enough");
  finish();
  assert.equal(await waiting, true);
  assert.deepEqual(paths, ["/", "/login"]);
});

test("retries a reset connection and accepts a fully served error page", async (t) => {
  let requests = 0;
  const server = await serverFor(t, (request, response) => {
    if (++requests === 1) return request.socket.destroy();
    response.writeHead(503);
    response.end("rendered error");
  });
  assert.equal(await waitForPage(`http://127.0.0.1:${server.address().port}/`), true);
  assert.equal(requests, 2);
});

test("retries connection refusal until the listener becomes available", async (t) => {
  const server = await serverFor(t, (_request, response) => response.end("page"));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  const waiting = waitForPage(`http://127.0.0.1:${port}/`);
  await delay(50);
  server.listen(port, "127.0.0.1");
  await once(server, "listening");
  assert.equal(await waiting, true);
});

test("deadline covers a stalled body and refuses unknown port 0 without a request", async (t) => {
  const server = await serverFor(t, (_request, response) => response.write("never completes"));
  assert.equal(await waitForPage(`http://127.0.0.1:${server.address().port}/`, 100), false);
  assert.equal(await waitForPage("http://127.0.0.1:0/"), false);
});

test("IPv6 wildcard probes use a loopback Host accepted by the host guard", async (t) => {
  let host;
  const server = await serverFor(t, (request, response) => {
    host = request.headers.host;
    response.end("page");
  }, "::1");
  assert.equal(await waitForPage(`http://[::]:${server.address().port}/`), true);
  assert.equal(host, `[::1]:${server.address().port}`);
  assert.equal(isHostHeaderAllowed(host, []), true);
});
