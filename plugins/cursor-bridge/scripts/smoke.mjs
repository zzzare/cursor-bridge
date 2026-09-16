// End-to-end check over real stdio MCP: starts the server the way an MCP client does, lists the tools and checks the API key.
// With --run <folder> it also makes one small read-only local run plus a follow-up, which uses the account's Cursor usage.
//   node scripts/smoke.mjs [--run <folder>] [--rules] [--model composer-2.5] [--server <path to another launch.mjs>]
// --rules loads the folder's Cursor project rules, which makes the SDK log and so exercises the stdout guard in launch.mjs.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { values } = parseArgs({ options: { run: { type: "string" }, rules: { type: "boolean" }, model: { type: "string" }, server: { type: "string" } } });
const failures = [];
const check = (ok, label) => { console.log(`${ok ? "PASS" : "FAIL"} ${label}`); if (!ok) failures.push(label); };

const env = Object.fromEntries(Object.entries(process.env).filter(([, v]) => typeof v === "string"));
const launcher = values.server ? resolve(values.server) : join(root, "server", "launch.mjs");
const transport = new StdioClientTransport({ command: process.execPath, args: [launcher], env, stderr: "pipe" });
const serverStderr = [];
transport.stderr?.on("data", chunk => serverStderr.push(...String(chunk).split(/\r?\n/).filter(Boolean)));
const client = new Client({ name: "cursor-bridge-smoke", version: "0.0.0" });
client.onerror = error => { console.log(`client error: ${error.message}`); failures.push(`client error: ${error.message}`); };

async function call(name, args = {}, { quiet = false } = {}) {
  const started = Date.now();
  const options = { timeout: 30 * 60_000, resetTimeoutOnProgress: true, onprogress: p => console.log(`  progress: ${p.message ?? p.progress}`) };
  const result = await client.callTool({ name, arguments: args }, undefined, options);
  const text = result.content.map(c => c.text ?? "").join("\n");
  const shown = quiet ? text.split("\n").slice(0, 6).join("\n") + "\n..." : text;
  console.log(`\n### ${name} (${Math.round((Date.now() - started) / 1000)}s${result.isError ? ", isError" : ""})\n${shown}\n`);
  return { text, isError: result.isError === true };
}

await client.connect(transport);
const { tools } = await client.listTools();
const names = tools.map(t => t.name).sort();
console.log(`tools: ${names.join(", ")}`);
check(names.length === 8, "server exposes 8 tools");

const auth = await call("cursor_auth", { action: "status" });
check(!auth.isError && /API key|Signed in/.test(auth.text), "cursor_auth reports a usable credential");

const models = await call("cursor_models", {}, { quiet: true });
check(!models.isError && /works/.test(models.text), "cursor_models reaches Cursor with the API key");

if (values.run) {
  const folder = resolve(values.run);
  const marker = join(folder, "cursor-bridge-write-test.txt");
  const first = await call("cursor_run_local", {
    prompt: "Smoke test, keep it short. 1) Name the one file in this folder that best describes the project. 2) Try to create a file named cursor-bridge-write-test.txt containing the word test, then say plainly whether you could. Put everything in your final message, under 50 words.",
    cwd: folder, model: values.model ?? "composer-2.5", load_project_rules: values.rules === true, name: "cursor-bridge smoke", wait_seconds: 300,
  });
  const agentId = first.text.match(/agent_id: (\S+)/)?.[1];
  check(!first.isError && /Cursor agent finished/.test(first.text), "local run finished and returned a reply");
  check(!existsSync(marker), "read-only agent did not create a file");
  if (agentId) {
    const second = await call("cursor_followup", { agent_id: agentId, prompt: "Which file name did you give in your previous answer? Reply with just the name.", wait_seconds: 300 });
    check(!second.isError && /Cursor agent finished/.test(second.text), "follow-up on the same agent finished");
    const status = await call("cursor_status", { agent_id: agentId });
    check((status.text.match(/: finished/g) ?? []).length >= 2, "cursor_status lists both runs as finished");
    const again = await call("cursor_wait", { agent_id: agentId, wait_seconds: 0 }, { quiet: true });
    check(/Cursor agent finished/.test(again.text), "cursor_wait returns the finished reply from memory");
  }
}

await client.close();
console.log(`\nserver stderr (${serverStderr.length} lines):\n${serverStderr.slice(0, 15).map(l => `  ${l}`).join("\n")}`);
console.log(failures.length ? `\n${failures.length} check(s) failed` : "\nall checks passed");
process.exitCode = failures.length ? 1 : 0;
