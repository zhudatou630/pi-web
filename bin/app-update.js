"use strict";

/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

// Only offer updates when npm's global package is exactly this installation.
function getGlobalNpmCli(pkgDir, env = process.env) {
  if (env.INVOCATION_ID || env.pm_id || env.PM2_HOME || fs.existsSync(path.join(pkgDir, ".git"))) return undefined;
  for (const dir of (env.PATH || "").split(path.delimiter)) {
    try {
      const npmCli = process.platform === "win32"
        ? path.join(dir, "node_modules", "npm", "bin", "npm-cli.js")
        : fs.realpathSync(path.join(dir, "npm"));
      if (!fs.existsSync(npmCli)) continue;
      const result = spawnSync(process.execPath, [npmCli, "root", "-g"], {
        env, encoding: "utf8", timeout: 5000, windowsHide: true,
      });
      if (result.status !== 0) continue;
      const root = result.stdout.trim();
      const installed = fs.realpathSync(path.join(root, "@calmabacus", "pi-web"));
      if (installed !== fs.realpathSync(pkgDir)) return undefined;
      fs.accessSync(root, fs.constants.W_OK);
      fs.accessSync(path.dirname(installed), fs.constants.W_OK);
      fs.accessSync(installed, fs.constants.W_OK);
      return npmCli;
    } catch { /* A missing npm or read-only install uses manual updates. */ }
  }
  return undefined;
}

module.exports = { getGlobalNpmCli };
