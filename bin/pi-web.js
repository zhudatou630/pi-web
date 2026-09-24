#!/usr/bin/env node
"use strict";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getUnsupportedNodeVersionMessage, isNodeVersionSupported } = require("./node-version");

if (!isNodeVersionSupported(process.versions.node)) {
  console.error(getUnsupportedNodeVersionMessage(process.versions.node));
  process.exit(1);
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { spawn } = require("child_process");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const path = require("path");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fs = require("fs");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getHelpText, parseLaunchOptions } = require("./pi-web-options");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { wireChildProcessLifecycle } = require("./process-lifecycle");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getGlobalNpmCli } = require("./app-update");

let launchOptions;
try {
  launchOptions = parseLaunchOptions();
} catch (error) {
  fs.writeSync(
    process.stderr.fd,
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
}

if (launchOptions.help) {
  fs.writeSync(process.stdout.fd, getHelpText());
  process.exit(0);
}

const { port, hostname, openBrowser } = launchOptions;

const pkgDir = path.join(__dirname, "..");
const nextDir = path.join(pkgDir, ".next");

// Resolve next's CLI entry directly to avoid relying on .bin symlinks (which
// may not exist when installed via npx).
let nextBin;
try {
  nextBin = require.resolve("next/dist/bin/next", { paths: [pkgDir] });
} catch {
  // Fallback: locate next package root and derive the bin path manually.
  try {
    const nextPkg = require.resolve("next/package.json", { paths: [pkgDir] });
    nextBin = path.join(path.dirname(nextPkg), "dist", "bin", "next");
  } catch {
    nextBin = path.join(pkgDir, "node_modules", "next", "dist", "bin", "next");
  }
}

const loopbackHostnames = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const passwordEnabled = Boolean(process.env.PI_WEB_PASSWORD);

if (!fs.existsSync(nextDir)) {
  console.error("Build artifacts not found. Please report this issue.");
  process.exit(1);
}

if (!loopbackHostnames.has(hostname)) {
  if (passwordEnabled) {
    console.warn(
      `Warning: pi-web is listening on ${hostname} with password authentication over HTTP. Use HTTPS or a trusted VPN to protect the password in transit.`,
    );
  } else {
    console.warn(
      `Warning: pi-web is listening on ${hostname} without authentication. Only use this on a trusted network.`,
    );
  }
}

const nextArgs = ["start", "-p", port];
nextArgs.push("-H", hostname);

const npmUpdate = getGlobalNpmCli(pkgDir);
const npmCli = npmUpdate?.npmCli;

function installUpdate() {
  console.log("[pi-web] Installing the latest version…");
  const installer = spawn(process.execPath, [npmCli, "install", "-g", "@calmabacus/pi-web@latest"], {
    cwd: path.dirname(pkgDir),
    stdio: "inherit",
    env: process.env,
  });
  wireChildProcessLifecycle(installer, process, 5000, console.error, (code, signal, shuttingDown) => {
    if (shuttingDown) return false;
    if (code === 0 && !signal) {
      startServer(false);
    } else {
      // npm usually fails before touching the installed files (network), so
      // the old version is still intact — keep serving it instead of leaving
      // a silently dead port under a process supervisor.
      // ponytail: a half-written package would crash this restart and let the
      // supervisor loop; rare and visible in logs, real fix = tarball rollback.
      console.error("[pi-web] Update failed; still running the previous version. To retry: npm install -g @calmabacus/pi-web@latest && pi-web");
      startServer(false);
    }
    return true;
  });
}

function startServer(shouldOpenBrowser) {
  let updating = false;
  let stopTimer;
  // Always run next's JS entry with node directly — avoids .bin symlink issues
  // and path-with-spaces problems on Windows when shell: true is used.
  const child = spawn(process.execPath, [nextBin, ...nextArgs], {
    cwd: pkgDir,
    stdio: ["inherit", "pipe", "inherit", "ipc"],
    env: {
      ...process.env,
      PI_WEB_HOSTNAME: hostname,
      PI_WEB_CAN_UPDATE: npmCli ? "1" : "0",
      ...(npmUpdate?.reason ? { PI_WEB_UPDATE_BLOCKED: npmUpdate.reason } : {}),
    },
  });
  wireChildProcessLifecycle(child, process, 5000, console.error, (_code, _signal, shuttingDown) => {
    clearTimeout(stopTimer);
    if (!updating || shuttingDown) return false;
    installUpdate();
    return true;
  });
  child.on("message", (message) => {
    if (!npmCli || message?.type !== "pi-web:update" || updating) return;
    updating = true;
    child.kill("SIGTERM");
    stopTimer = setTimeout(() => child.kill("SIGKILL"), 5000);
    stopTimer.unref();
  });

  let browserOpened = false;
  const url = `http://${hostname}:${port}`;

  child.stdout.on("data", (chunk) => {
    const text = chunk.toString();
    process.stdout.write(text);
    if (shouldOpenBrowser && !browserOpened && text.includes("Ready")) {
      browserOpened = true;
      const isWindows = process.platform === "win32";
      const isMac = process.platform === "darwin";
      // Avoid `shell: true` to suppress Node.js DEP0190 deprecation
      // ("Passing args to a child process with shell option true can lead to
      // security vulnerabilities, as the arguments are not escaped").
      // Pass a structured argv so Node.js handles escaping instead of
      // concatenating the args into a shell command string.
      let opener;
      if (isWindows) {
        // `start` is a cmd.exe built-in, so invoke cmd directly. The empty
        // title argument is required by `start` before the target URL.
        opener = spawn(process.env.ComSpec || "cmd.exe", ["/c", "start", "", url], {
          stdio: "ignore",
          detached: true,
        });
      } else if (isMac) {
        opener = spawn("open", [url], {
          stdio: "ignore",
          detached: true,
        });
      } else {
        opener = spawn("xdg-open", [url], {
          stdio: "ignore",
          detached: true,
        });
      }

      opener.on("error", (error) => {
        console.warn(`Could not open browser automatically: ${error.message}`);
      });

      opener.unref();
    }
  });
}

startServer(openBrowser);
