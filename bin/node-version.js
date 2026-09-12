"use strict";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { gte, valid } = require("semver");

const MIN_NODE_VERSION = "22.19.0";

function isNodeVersionSupported(version) {
  return valid(version) !== null && gte(version, MIN_NODE_VERSION);
}

function getUnsupportedNodeVersionMessage(version) {
  return [
    `Pi Web requires Node.js ${MIN_NODE_VERSION} or newer.`,
    `Current Node.js version: ${version}.`,
    "Upgrade Node.js and try again: https://nodejs.org/",
  ].join("\n");
}

module.exports = {
  MIN_NODE_VERSION,
  getUnsupportedNodeVersionMessage,
  isNodeVersionSupported,
};
