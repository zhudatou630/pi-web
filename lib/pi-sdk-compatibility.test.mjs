import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { importSdkFile } = await createJiti(import.meta.url).import("./builtin-extensions.ts");

test("installed pi SDK retains every private module/export used by Pi Web", async () => {
  for (const [file, functions] of Object.entries({
    "extensions/llama/provider.js": ["createLlamaProvider"],
    "core/mcp-servers.js": ["validateMcpServerConfig", "getMcpToolExposure"],
    "core/resolve-config-value.js": ["getConfigValueEnvVarNames", "isCommandConfigValue"],
    "core/auth-storage.js": ["FileAuthStorageBackend"],
    "extensions/mcp/runtime.js": ["createDefaultTransport", "McpServerConnection", "McpOAuthCredentialStore", "McpServerLog", "McpSignInCancelledError", "signInMcpServer"],
    "extensions/mcp/cli.js": ["runMcpCommand"],
    "extensions/mcp/config.js": ["loadMcpConfig"],
    "utils/json.js": ["stripJsonComments"],
    "core/bug-report.js": ["bugReportArchiveFileName", "collectBugReportMetadata", "collectBugReportDiagnostics", "writeBugReportArchive"],
    "core/bug-report-upload.js": ["uploadBugReport"],
    "core/crash-log.js": ["readCrashLog", "clearCrashLog"],
    "core/export-html/index.js": ["exportFromFile"],
    "core/agent-session.js": ["markRuntimeStreamFunction"],
  })) {
    const sdk = await importSdkFile(file);
    for (const name of functions) assert.equal(typeof sdk[name], "function", `${file}: ${name}`);
    if (file === "core/bug-report.js") assert.equal(typeof sdk.BUG_REPORT_CUSTOM_ENTRY_TYPE, "string");
  }
});
