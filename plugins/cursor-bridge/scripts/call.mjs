// Calls cursor-bridge tools over stdio MCP from a shell, for manual testing without an MCP client.
//   node scripts/call.mjs --list                          tools with descriptions and parameters
//   node scripts/call.mjs <tool> '<json arguments>'       one call
//   node scripts/call.mjs --batch <calls.json>            JSON array of {"name", "arguments"}, run in order in one server session
// Local runs live inside the server process, so use --batch when a later call (cursor_wait, cursor_followup) needs an earlier run.
// In a batch, the text {{agent_id}} in any argument is replaced with the agent_id from the most recent result.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const [first, second] = process.argv.slice(2);
const usage = "usage: node scripts/call.mjs --list | <tool> '<json arguments>' | --batch <calls.json>\n";
if (!first || first === "--help" || first === "-h") {
  (first ? process.stdout : process.stderr).write(usage);
  process.exit(first ? 0 : 2);
}

const substitute = (value, agentId) => typeof value === "string" ? (agentId ? value.replaceAll("{{agent_id}}", agentId) : value)
  : Array.isArray(value) ? value.map(v => substitute(v, agentId))
  : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substitute(v, agentId)]))
  : value;

const env = Object.fromEntries(Object.entries(process.env).filter(([, v]) => typeof v === "string"));
const client = new Client({ name: "cursor-bridge-call", version: "0.0.0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(root, "server", "launch.mjs")], env, stderr: "ignore" }));

let failed = false;
try {
  if (first === "--list") {
    const { tools } = await client.listTools();
    for (const tool of tools) {
      console.log(`## ${tool.name}\n${tool.description}`);
      for (const [param, schema] of Object.entries(tool.inputSchema?.properties ?? {})) {
        const kind = schema.enum ? schema.enum.map(v => JSON.stringify(v)).join(" | ") : schema.type;
        const required = tool.inputSchema.required?.includes(param) ? ", required" : "";
        console.log(`- ${param} (${kind}${required}): ${schema.description ?? ""}`);
      }
      console.log();
    }
  } else {
    const calls = first === "--batch" ? JSON.parse(readFileSync(second, "utf8")) : [{ name: first, arguments: second ? JSON.parse(second) : {} }];
    let lastAgentId;
    for (const { name, arguments: args = {} } of calls) {
      const started = Date.now();
      const options = { timeout: 60 * 60_000, resetTimeoutOnProgress: true, onprogress: p => process.stderr.write(`  progress: ${p.message ?? p.progress}\n`) };
      const result = await client.callTool({ name, arguments: substitute(args, lastAgentId) }, undefined, options);
      const text = result.content.map(c => c.text ?? "").join("\n");
      lastAgentId = text.match(/agent_id: (\S+)/)?.[1] ?? lastAgentId;
      failed ||= result.isError === true;
      console.log(`### ${name} (call took ${Math.round((Date.now() - started) / 1000)}s${result.isError ? ", isError" : ""})`);
      console.log(`${text}\n`);
    }
  }
} finally {
  await client.close();
}
process.exitCode = failed ? 1 : 0;
