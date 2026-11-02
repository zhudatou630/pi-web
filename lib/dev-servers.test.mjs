import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  const { createJiti } = await import("jiti");
  return createJiti(import.meta.url).import("./dev-servers.ts");
}

test("loopbackAddress keeps loopback and wildcard binds, drops other interfaces", async () => {
  const { loopbackAddress } = await loadSubject();
  assert.deepEqual(loopbackAddress("127.0.0.1:3000"), { host: "127.0.0.1", port: 3000 });
  assert.deepEqual(loopbackAddress("*:5173"), { host: "127.0.0.1", port: 5173 });
  assert.deepEqual(loopbackAddress("0.0.0.0:80"), { host: "127.0.0.1", port: 80 });
  assert.deepEqual(loopbackAddress("[::]:8080"), { host: "[::1]", port: 8080 });
  assert.deepEqual(loopbackAddress("[::1]:4000"), { host: "[::1]", port: 4000 });
  assert.equal(loopbackAddress("100.116.97.80:10443"), null);
  assert.equal(loopbackAddress("[fe80::1%eth0]:22"), null);
  assert.equal(loopbackAddress("127.0.0.1:*"), null);
});

test("parseSs reads address, pid and name (names may contain spaces)", async () => {
  const { parseSs } = await loadSubject();
  const out = [
    "LISTEN 0      511          127.0.0.1:30143      0.0.0.0:* users:((\"next-server (v1\",pid=1777981,fd=22))",
    "LISTEN 0      4096     100.116.97.80:10443      0.0.0.0:*",
    "LISTEN 0      511                  *:5173             *:* users:((\"node\",pid=42,fd=3),(\"node\",pid=43,fd=3))",
    "LISTEN 0      4096         127.0.0.1:9090       0.0.0.0:*",
    "",
  ].join("\n");
  assert.deepEqual(parseSs(out), [
    { host: "127.0.0.1", port: 30143, pid: 1777981, process: "next-server (v1" },
    { host: "127.0.0.1", port: 5173, pid: 42, process: "node" },
    { host: "127.0.0.1", port: 9090, pid: null, process: null },
  ]);
});

test("parseLsof attributes each address to the preceding process", async () => {
  const { parseLsof } = await loadSubject();
  const out = [
    "p100", "cnode", "f20", "tIPv4", "n*:3000", "f21", "tIPv6", "n[::1]:3001", "f22", "tIPv6", "n*:3002",
    "p200", "cpostgres", "f5", "tIPv4", "n10.0.0.2:5432", "",
  ].join("\n");
  assert.deepEqual(parseLsof(out), [
    { host: "127.0.0.1", port: 3000, pid: 100, process: "node" },
    { host: "[::1]", port: 3001, pid: 100, process: "node" },
    { host: "[::1]", port: 3002, pid: 100, process: "node" },
  ]);
});

test("parseNetstat takes TCP sockets with a :0 peer, whatever the localized state", async () => {
  const { parseNetstat } = await loadSubject();
  const out = [
    "  Proto  Local Address          Foreign Address        State           PID",
    "  TCP    0.0.0.0:3000           0.0.0.0:0              ABH\u00d6REN         1234",
    "  TCP    127.0.0.1:3000         127.0.0.1:51000        ESTABLISHED     1234",
    "  TCP    [::1]:5173             [::]:0                 LISTENING       99",
    "  UDP    0.0.0.0:5353           *:*                                    7",
  ].join("\r\n");
  assert.deepEqual(parseNetstat(out), [
    { host: "127.0.0.1", port: 3000, pid: 1234, process: null },
    { host: "[::1]", port: 5173, pid: 99, process: null },
  ]);
});
