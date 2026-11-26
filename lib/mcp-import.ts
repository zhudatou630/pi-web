import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importSdkFile } from "./builtin-extensions";

type Server = { name: string; config: Record<string, unknown> };
type ImportResult = { servers: Server[]; notes: string[] } | { error: string };
type ImportDeps = {
  validateMcpServerConfig: (name: string, config: unknown) => Record<string, unknown> | string;
  runMcpCommand: (args: string[], options: {
    cwd: string; agentDir: string; log: (line: string) => void; error: (line: string) => void;
  }) => Promise<number>;
};
type Entry = [string, unknown];

const SSE_ERROR = "Pi supports only streamable HTTP, not legacy SSE; try /mcp instead of /sse.";
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const sanitizeName = (name: string) => name.replace(/[^A-Za-z0-9_-]/g, "-") || "mcp";

function commandName(command: string, args: string[]): string {
  let source = command;
  if (command === "npx" || command === "uvx") source = args.find((arg) => !arg.startsWith("-")) ?? command;
  if (command === "docker" && args[0] === "run") source = args.slice(1).find((arg) => !arg.startsWith("-")) ?? command;
  const packageName = source.split(/[\\/]/).pop()!.replace(/@.*$/, "").replace(/^server-/, "");
  return sanitizeName(packageName);
}

function configName(config: Record<string, unknown>): string {
  if (typeof config.url === "string" && URL.canParse(config.url)) {
    return sanitizeName(new URL(config.url).hostname.replace(/^(mcp|www)\./, "").split(".")[0]);
  }
  return commandName(typeof config.command === "string" ? config.command : "mcp",
    Array.isArray(config.args) ? config.args.filter((arg): arg is string => typeof arg === "string") : []);
}

/** Shell words only: quotes and escapes, never expansion or execution. */
function shellWords(text: string): string[] {
  const words: string[] = [];
  let word = "", quote = "", started = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === "\\" && quote !== "'") {
      const next = text[i + 1];
      if (next === undefined) throw new Error("The command ends with an unfinished escape.");
      if (quote === '"' && !['"', "\\", "$", "`", "\n"].includes(next)) {
        word += char;
      } else {
        if (next !== "\n") { word += next; started = true; }
        i++;
      }
    } else if (quote) {
      if (char === quote) quote = "";
      else word += char;
    } else if (char === "'" || char === '"') {
      quote = char;
      started = true;
    } else if (/\s/.test(char)) {
      if (started) words.push(word);
      word = "";
      started = false;
    } else {
      word += char;
      started = true;
    }
  }
  if (quote) throw new Error("The command has an unclosed quote.");
  if (started) words.push(word);
  return words;
}

function commandPrefix(words: string[]) {
  const env: [string, string][] = [];
  let i = 0;
  const assignments = () => {
    while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i] ?? "")) {
      const pair = words[i++], separator = pair.indexOf("=");
      env.push([pair.slice(0, separator), pair.slice(separator + 1)]);
    }
  };
  assignments();
  if (programName(words[i]) === "env") {
    i++;
    assignments();
    if (words[i]?.startsWith("-")) throw new Error("env options are not supported in an MCP command.");
  }
  return { env, program: words.slice(i) };
}

const cliPackages = new Map([
  ["@earendil-works/pi-coding-agent", "pi"], ["@anthropic-ai/claude-code", "claude"],
  ["@openai/codex", "codex"], ["@google/gemini-cli", "gemini"],
]);
const agentClis = new Set(cliPackages.values());

function programName(word = ""): string {
  return word.split(/[\\/]/).pop()!.replace(/\.(?:exe|cmd)$/i, "");
}

const withoutVersion = (pkg: string) => pkg.replace(/(?!^)@[^/]*$/, "");
const agentCliName = (word: string) => cliPackages.get(withoutVersion(word)) ?? (agentClis.has(word) ? word : undefined);

/** The program a package runner (`npx`, `npm exec`, `pnpm dlx`, …) starts, and where its arguments begin. */
function runProgram(program: string[]): { cli: string; index: number } {
  const cli = programName(program[0]);
  if (["npm", "pnpm", "yarn"].includes(cli)) {
    // Their options take values in many forms: any word naming an agent CLI or its package is the program.
    for (let index = 1; index < program.length; index++) {
      const agent = agentCliName(program[index]);
      if (agent) return { cli: agent, index: index + 1 };
    }
    return { cli, index: 1 };
  }
  if (!["npx", "bunx", "pnpx"].includes(cli)) return { cli, index: 1 };
  // Options, including `--`, come before the package.
  let index = 1;
  while (program[index]?.startsWith("-")) index += ["-p", "--package"].includes(program[index]) ? 2 : 1;
  const pkg = withoutVersion(program[index++] ?? "");
  return { cli: cliPackages.get(pkg) ?? programName(pkg), index };
}

/** Save tests a pasted server by running it: an agent CLI line (logout, mcp remove, updates, …) must not get there. */
function refuseAgentCli(program: string[]): void {
  const { cli, index } = runProgram(program);
  const sub = program[index], action = program[index + 1];
  if (!agentClis.has(cli) || (cli === "claude" && sub === "mcp" && action === "serve") || (cli === "codex" && sub === "mcp-server")) return;
  throw new Error(sub === "mcp" && action === "add" && cli !== "pi" && cli !== "claude"
    ? `Importing \`${cli} mcp add\` is not supported. Paste the server's command or JSON configuration instead.`
    : `This ${cli} command is not an MCP server command.`);
}

async function piEntries(args: string[], deps: Partial<ImportDeps>): Promise<Entry[]> {
  const run = deps.runMcpCommand ?? (await importSdkFile<ImportDeps>("extensions/mcp/cli.js")).runMcpCommand;
  const root = await mkdtemp(join(tmpdir(), "pi-web-mcp-import-"));
  try {
    const cwd = join(root, "project"), agentDir = join(root, "agent");
    await Promise.all([mkdir(cwd), mkdir(agentDir)]);
    const errors: string[] = [];
    const code = await run(["add", ...args], { cwd, agentDir, log: () => {}, error: (line) => errors.push(line) });
    if (code !== 0) throw new Error(errors.join("\n") || "Pi could not parse this MCP command.");
    const entries: Entry[] = [];
    for (const path of [join(agentDir, "mcp.json"), join(cwd, ".pi", "mcp.json")]) {
      let text: string;
      try { text = await readFile(path, "utf8"); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      const document: unknown = JSON.parse(text);
      if (isRecord(document) && isRecord(document.mcpServers)) entries.push(...Object.entries(document.mcpServers));
    }
    if (!entries.length) throw new Error(errors.join("\n") || "Pi did not create a server entry; help alone cannot be imported.");
    return entries;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function claudeEntry(args: string[], notes: string[]): Entry {
  let transport = "stdio", options = true;
  const positional: string[] = [], env: [string, string][] = [], headers: [string, string][] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (positional.length >= 2) { positional.push(...args.slice(i)); break; }
    if (options && arg === "--") { options = false; continue; }
    if (options && arg.startsWith("-")) {
      if (!["-t", "--transport", "-e", "--env", "-H", "--header", "-s", "--scope"].includes(arg)) {
        throw new Error(`Unknown Claude option ${arg}.`);
      }
      const value = args[++i];
      if (value === undefined) throw new Error(`${arg} needs a value.`);
      if (arg === "-t" || arg === "--transport") transport = value;
      else if (arg === "-s" || arg === "--scope") notes.push("Claude's --scope is ignored; choose the scope below.");
      else {
        const header = arg === "-H" || arg === "--header";
        const separator = value.indexOf(header ? ":" : "=");
        if (separator <= 0) throw new Error(`${arg} expects ${header ? "K: V" : "KEY=VALUE"}.`);
        const key = value.slice(0, separator);
        const content = value.slice(separator + 1);
        if (header) headers.push([key.trim(), content.trimStart()]);
        else env.push([key, content]);
      }
    } else positional.push(arg);
  }
  const [name, target, ...commandArgs] = positional;
  if (!name || !target) throw new Error("Claude mcp add needs a server name and a command or URL.");
  if (!["stdio", "http", "sse"].includes(transport)) throw new Error("Claude transport must be stdio, http, or sse.");
  if (transport === "stdio") {
    if (headers.length) throw new Error("Claude headers require an HTTP transport.");
    return [name, { command: target, args: commandArgs, ...(env.length ? { env: Object.fromEntries(env) } : {}) }];
  }
  if (env.length || commandArgs.length) throw new Error("Claude HTTP servers cannot have command arguments or env options.");
  return [name, { type: transport, url: target, ...(headers.length ? { headers: Object.fromEntries(headers) } : {}) }];
}

function jsonEntries(text: string): Entry[] {
  let document: unknown;
  try { document = JSON.parse(text); }
  catch { throw new Error("Invalid JSON."); }
  if (!isRecord(document)) throw new Error("MCP JSON must be an object.");
  if ("command" in document || "url" in document) return [[configName(document), document]];
  const map = document.mcpServers ?? document.servers ?? document;
  if (!isRecord(map)) throw new Error("The server map must be an object.");
  return Object.entries(map);
}

function normalizeJson(name: string, value: unknown, notes: string[]): unknown {
  if (typeof value === "string") {
    if (value.startsWith("!")) notes.push(`Server "${name}": a value starting with ! runs a command when the server starts.`);
    if (value.includes("${input:")) notes.push(`Server "${name}": replace VS Code \${input:id} references with \${NAME} environment variables.`);
    return value.replace(/\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, "${$1}");
  }
  if (Array.isArray(value)) return value.map((item) => normalizeJson(name, item, notes));
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalizeJson(name, item, notes)]));
  return value;
}

/** Parse a paste for preview only; SDK add runs exclusively in a disposable directory. */
export async function parseMcpPaste(text: string, deps: Partial<ImportDeps> = {}): Promise<ImportResult> {
  try {
    text = text.trim();
    if (!text) return { error: "Paste an MCP URL, command, or JSON configuration." };
    const notes: string[] = [];
    const json = text.startsWith("{") || text.startsWith("[");
    let entries: Entry[];
    if (json) entries = jsonEntries(text);
    else if (/^https?:\/\//i.test(text) || /^localhost(?::\d+)?(?:\/|$)/i.test(text)) {
      const config = { url: /^https?:\/\//i.test(text) ? text : `http://${text}` };
      entries = [[configName(config), config]];
    } else {
      const { env, program } = commandPrefix(shellWords(text));
      const [command, ...args] = program;
      if (!command) throw new Error("A command is required after environment assignments.");
      const { cli, index } = runProgram(program);
      const sub = program[index], action = program[index + 1];
      if ((cli === "pi" || cli === "claude") && sub === "mcp" && action === "add") {
        // The prefix configures the CLI process, not the server being added.
        entries = cli === "pi" ? await piEntries(program.slice(index + 2), deps) : [claudeEntry(program.slice(index + 2), notes)];
        for (const [, config] of entries) {
          if (isRecord(config) && typeof config.command === "string") {
            refuseAgentCli([config.command, ...(Array.isArray(config.args) ? config.args.map(String) : [])]);
          }
        }
      } else {
        refuseAgentCli(program);
        entries = [[commandName(command, args), { command, args, ...(env.length ? { env: Object.fromEntries(env) } : {}) }]];
      }
    }
    const validate = deps.validateMcpServerConfig ?? (await importSdkFile<ImportDeps>("core/mcp-servers.js")).validateMcpServerConfig;
    const servers: Server[] = [], errors: string[] = [];
    for (const [name, raw] of entries) {
      const config = json ? normalizeJson(name, raw, notes) : raw;
      const validated = validate(name, config);
      if (typeof validated === "string") {
        errors.push(isRecord(config) && config.type === "sse" ? `${validated}. ${SSE_ERROR}` : validated);
      } else if (isRecord(config)) servers.push({ name, config });
    }
    if (!servers.length) return { error: errors.join("\n") || "No MCP server entries found." };
    return { servers, notes: [...new Set([...notes, ...errors])] };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}
