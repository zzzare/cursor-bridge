#!/usr/bin/env node
// Entry point for the cursor-bridge MCP server. Keeps stdout for the MCP protocol, installs npm dependencies when they
// are missing, then starts the server. Uses only Node built-ins so it runs before dependencies exist.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { Writable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const log = message => process.stderr.write(`[cursor-bridge] ${message}\n`);

const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  log(`Node ${process.versions.node} is too old: @cursor/sdk needs Node 22.13 or newer.`);
  process.exit(1);
}

// stdout carries the MCP protocol, and a stray write (SDK log lines, a dependency's console.log) would corrupt it.
// The transport gets its own handle on the real stdout; every other stdout write goes to stderr.
const writeStdout = process.stdout.write.bind(process.stdout);
const protocolOut = new Writable({ write: (chunk, _encoding, callback) => { writeStdout(chunk, callback); } });
process.stdout.write = (chunk, encoding, callback) => process.stderr.write(chunk, encoding, callback);

// node:sqlite (the SDK's local agent store) prints an ExperimentalWarning on every start; drop just that one.
const emitWarning = process.emitWarning.bind(process);
process.emitWarning = (warning, ...rest) => String(warning?.message ?? warning).includes("SQLite is an experimental feature") ? undefined : emitWarning(warning, ...rest);

const required = ["@cursor/sdk", "@modelcontextprotocol/sdk", "zod"];
const missing = required.filter(pkg => !existsSync(join(root, "node_modules", ...pkg.split("/"), "package.json")));
if (missing.length) {
  // Claude Code installs plugin dependencies itself, but skips it for plugins loaded in place and gives up after 60 seconds.
  const args = [existsSync(join(root, "package-lock.json")) ? "ci" : "install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"];
  log(`missing ${missing.join(", ")}; running npm ${args[0]} in ${root} (can take a minute)`);
  const options = { cwd: root, stdio: ["ignore", 2, 2], windowsHide: true };
  // npm is a .cmd shim on Windows, which needs a shell. Node deprecates shell plus an args array (DEP0190), so pass one
  // command string; every part of it is a constant above.
  const result = process.platform === "win32" ? spawnSync(`npm ${args.join(" ")}`, { ...options, shell: true }) : spawnSync("npm", args, options);
  if (result.status !== 0) {
    log(`npm ${args[0]} failed (exit ${result.status ?? result.error?.message}). Run it manually in ${root}.`);
    process.exit(1);
  }
}

const { startServer } = await import(pathToFileURL(join(root, "server", "index.mjs")).href);
await startServer({ protocolOut });
