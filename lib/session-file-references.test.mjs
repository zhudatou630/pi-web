import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  return import("./session-file-references-core.ts");
}

test("detects exact external file paths referenced in session entries", async () => {
  const { isFilePathReferencedByEntries } = await loadSubject();
  const entries = [
    {
      type: "message",
      id: "entry-1",
      parentId: null,
      timestamp: "2026-01-01T00:00:00.000Z",
      message: {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "See [/home/me/.codex/config.toml:12](/home/me/.codex/config.toml:12)",
          },
        ],
      },
    },
  ];

  assert.equal(isFilePathReferencedByEntries("/home/me/.codex/config.toml", entries), true);
});

test("does not authorize sibling files by prefix match", async () => {
  const { isFilePathReferencedByEntries } = await loadSubject();
  const entries = [
    {
      type: "message",
      id: "entry-1",
      parentId: null,
      timestamp: "2026-01-01T00:00:00.000Z",
      message: {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "See /home/me/.codex/config.toml.bak",
          },
        ],
      },
    },
  ];

  assert.equal(isFilePathReferencedByEntries("/home/me/.codex/config.toml", entries), false);
});

test("authorizes full output only from a bash execution message", async () => {
  const { isBashOutputPathReferencedByEntries } = await loadSubject();
  const outputPath = "/tmp/pi-bash-ab12.log";
  const bashEntry = {
    type: "message",
    id: "entry-1",
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    message: {
      role: "bashExecution",
      command: "printf test",
      output: "test",
      fullOutputPath: outputPath,
    },
  };
  const assistantEntry = {
    type: "message",
    id: "entry-2",
    parentId: "entry-1",
    timestamp: "2026-01-01T00:00:01.000Z",
    message: {
      role: "assistant",
      content: [{ type: "text", text: `mentioned ${outputPath}` }],
    },
  };

  assert.equal(isBashOutputPathReferencedByEntries(outputPath, [bashEntry]), true);
  assert.equal(isBashOutputPathReferencedByEntries(outputPath, [assistantEntry]), false);
  assert.equal(isBashOutputPathReferencedByEntries("/tmp/pi-bash-other.log", [bashEntry]), false);
});

test("only coding/subagent results and model-visible references authorize external paths", async () => {
  const { isFilePathReferencedByEntries: referenced } = await loadSubject();
  const file = "/tmp/private/config.json";
  const text = [{ type: "text", text: file }];
  const message = (role, fields = {}) => ({ type: "message", message: { role, content: text, ...fields } });
  for (const entry of [
    message("system"),
    { type: "context_edit", replacements: [{ content: text }] },
    { type: "custom", customType: "codemode-store", data: { file } },
    ...[undefined, "mcp_remote", "codemode", "extension", "web_search"].map((toolName) => message("toolResult", { toolName })),
  ]) assert.equal(referenced(file, [entry]), false, JSON.stringify(entry));
  for (const role of ["user", "assistant"]) assert.equal(referenced(file, [message(role)]), true);
  assert.equal(referenced(file, [message("assistant", { content: [{ type: "toolCall", name: "mcp_remote", arguments: { path: file } }] })]), true);
  for (const toolName of ["read", "bash", "powershell", "edit", "write", "grep", "find", "ls", "Agent", "get_subagent_result", "steer_subagent"]) {
    assert.equal(referenced(file, [message("toolResult", { toolName })]), true, toolName);
  }
});

test("untrusted results allow only fullOutputPath and nested coding-call arguments", async () => {
  const { isFilePathReferencedByEntries: referenced } = await loadSubject();
  const entry = { type: "message", message: {
    role: "toolResult", toolName: "codemode",
    content: [{ type: "text", text: "/tmp/from-content" }],
    details: { fullOutputPath: "/tmp/full-output", other: "/tmp/from-details" },
    nestedCalls: { calls: [
      { name: "read", arguments: { path: "/tmp/nested-read" }, result: "/tmp/nested-result" },
      { name: "bash", arguments: { command: "cat /tmp/nested-bash" } },
      { name: "mcp_remote", arguments: { path: "/tmp/nested-remote" } },
      { name: "Agent", arguments: { path: "/tmp/nested-agent" } },
    ] },
  } };
  for (const file of ["/tmp/full-output", "/tmp/nested-read", "/tmp/nested-bash"]) assert.equal(referenced(file, [entry]), true);
  for (const file of ["/tmp/from-content", "/tmp/from-details", "/tmp/nested-result", "/tmp/nested-remote", "/tmp/nested-agent"]) assert.equal(referenced(file, [entry]), false);
  for (const nestedCalls of [null, { calls: "bad" }, { calls: [null, { name: 12 }] }]) {
    assert.equal(referenced("/tmp/full-output", [{ ...entry, message: { ...entry.message, nestedCalls } }]), true);
  }
});

test("validates session ids before resolving session paths", async () => {
  const { isValidSessionId } = await loadSubject();

  assert.equal(isValidSessionId("not-a-session-id"), false);
  assert.equal(isValidSessionId("../../sessions/foo"), false);
  assert.equal(isValidSessionId("550e8400-e29b-41d4-a716-446655440000"), true);
});
