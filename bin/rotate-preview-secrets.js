"use strict";

// Published previewModeId values let x-prerender-revalidate skip Next's proxy.
// Rotate on every production launch, including restarts after an in-app update.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const crypto = require("crypto");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fs = require("fs");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const path = require("path");

const PRERENDER_MANIFEST = "prerender-manifest.json";

function rotatePreviewSecrets(nextDir) {
  const manifestPath = path.join(nextDir, PRERENDER_MANIFEST);
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (error) {
    return { ok: false, reason: error.code === "ENOENT" ? "missing" : "unreadable", error };
  }

  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)
    || !manifest.preview || typeof manifest.preview !== "object" || Array.isArray(manifest.preview)
    || !["previewModeId", "previewModeSigningKey", "previewModeEncryptionKey"]
      .every((key) => typeof manifest.preview[key] === "string" && manifest.preview[key].length > 0)) {
    return { ok: false, reason: "unexpected-shape" };
  }

  // A sibling file + rename prevents a half-written manifest from being read.
  const tempPath = path.join(nextDir, `${PRERENDER_MANIFEST}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`);
  try {
    manifest.preview = {
      ...manifest.preview,
      previewModeId: crypto.randomBytes(16).toString("hex"),
      previewModeSigningKey: crypto.randomBytes(32).toString("hex"),
      previewModeEncryptionKey: crypto.randomBytes(32).toString("hex"),
    };
    fs.writeFileSync(tempPath, JSON.stringify(manifest), { flag: "wx" });
    fs.renameSync(tempPath, manifestPath);
  } catch (error) {
    try {
      fs.rmSync(tempPath, { force: true });
    } catch {
      // Best effort cleanup; startup still fails closed.
    }
    return { ok: false, reason: "unwritable", error };
  }
  return { ok: true };
}

function getRotationError(reason) {
  const detail = reason === "unwritable"
    ? "the install directory is not writable"
    : reason === "missing"
      ? "its prerender manifest is missing"
      : reason === "unreadable"
        ? "its prerender manifest could not be read"
        : "its prerender manifest has an unexpected format";
  return `Error: refusing to start pi-web: could not rotate preview-mode secrets because ${detail}.\n` +
    "Without rotation, the published x-prerender-revalidate value can bypass authentication and Host/Origin checks. Use a writable install with valid build artifacts.";
}

module.exports = { PRERENDER_MANIFEST, rotatePreviewSecrets, getRotationError };
