// Core of cursor-bridge: turns tool arguments into @cursor/sdk calls, tracks runs between tool calls, and formats replies.
import { Agent, Cursor } from "@cursor/sdk";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join, resolve } from "node:path";

export const READ_ONLY_TOOLS = ["read", "grep", "glob", "ls"];
export const ACCESS_LEVELS = ["read-only", "no-tools", "full"];
export const AUTH_ACTIONS = ["status", "login", "logout"];
export const DEFAULT_WAIT_SECONDS = 110;
export const MAX_WAIT_SECONDS = 1800;
export const FALLBACK_MODEL = "composer-2.5";
const SETTLED_RUN_TTL_MS = 60 * 60_000;

/** Errors caused by bad arguments or configuration. Their message goes back to the caller unchanged. */
export class BridgeError extends Error {}

// Plugin placeholders the client did not expand arrive literally (e.g. "${user_config.cursor_api_key}"), so treat them as unset.
export function envValue(env, name) {
  const value = env[name]?.trim();
  return value && !value.includes("${") ? value : undefined;
}

export const envFlag = (env, name) => /^(1|true|yes|on)$/i.test(envValue(env, name) ?? "");

export function loadConfig(env = process.env) {
  const maxRunMinutes = Number(envValue(env, "CURSOR_BRIDGE_MAX_RUN_MINUTES") ?? 60);
  return {
    dataDir: envValue(env, "CURSOR_BRIDGE_DATA_DIR") ?? join(homedir(), ".cursor-bridge"),
    defaultModel: defaultModelFrom(env),
    allowLocalWrites: envFlag(env, "CURSOR_BRIDGE_ALLOW_LOCAL_WRITES") || envFlag(env, "CLAUDE_PLUGIN_OPTION_ALLOW_LOCAL_WRITES"),
    maxRunMinutes: Number.isFinite(maxRunMinutes) && maxRunMinutes >= 0 ? maxRunMinutes : 60,
    projectDir: envValue(env, "CLAUDE_PROJECT_DIR"),
  };
}

function defaultModelFrom(env) {
  const spec = envValue(env, "CURSOR_BRIDGE_DEFAULT_MODEL") ?? envValue(env, "CLAUDE_PLUGIN_OPTION_DEFAULT_MODEL") ?? FALLBACK_MODEL;
  try {
    return parseModelSpec(spec);
  } catch (error) {
    process.stderr.write(`[cursor-bridge] ignoring default model "${spec}": ${error.message}\n`);
    return { id: FALLBACK_MODEL };
  }
}

// The plugin passes its setting as CURSOR_BRIDGE_API_KEY rather than CURSOR_API_KEY: an empty setting would otherwise overwrite
// a CURSOR_API_KEY the user already has in their environment. With no key at all, the SDK uses a stored browser sign-in.
const KEY_SOURCES = [
  ["CURSOR_BRIDGE_API_KEY", "the plugin setting"],
  ["CURSOR_API_KEY", "the CURSOR_API_KEY environment variable"],
  ["CLAUDE_PLUGIN_OPTION_CURSOR_API_KEY", "the plugin setting"],
];

/** The configured API key and a description of where it came from, or undefined when only a browser sign-in could apply. */
export function resolveApiKeySource(env = process.env, readUserEnv = readWindowsUserEnvKey) {
  for (const [name, source] of KEY_SOURCES) {
    const key = envValue(env, name);
    if (key) return { key, source };
  }
  const key = readUserEnv();
  return key ? { key, source: "the CURSOR_API_KEY Windows user environment variable (read from the registry)" } : undefined;
}

export const resolveApiKey = (env = process.env, readUserEnv = readWindowsUserEnvKey) => resolveApiKeySource(env, readUserEnv)?.key;

// A key saved as a Windows user variable after the MCP client started is not in this process's environment yet.
export function readWindowsUserEnvKey() {
  if (process.platform !== "win32") return undefined;
  try {
    const out = execFileSync("reg", ["query", "HKCU\\Environment", "/v", "CURSOR_API_KEY"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    return out.match(/CURSOR_API_KEY\s+REG_(?:EXPAND_)?SZ\s+(\S+)/)?.[1];
  } catch {
    return undefined;
  }
}

/** "grok-4.6" or "grok-4.6:effort=high,fast=true" -> { id, params? } as the SDK expects. */
export function parseModelSpec(spec) {
  const text = String(spec ?? "").trim();
  const colon = text.indexOf(":");
  const id = (colon < 0 ? text : text.slice(0, colon)).trim();
  if (!id) throw new BridgeError(`Model "${text}" has no id. Use "model-id" or "model-id:param=value".`);
  if (colon < 0) return { id };
  const params = text.slice(colon + 1).split(",").map(p => p.trim()).filter(Boolean).map(p => {
    const eq = p.indexOf("=");
    if (eq < 1) throw new BridgeError(`Model param "${p}" must look like name=value.`);
    return { id: p.slice(0, eq).trim(), value: p.slice(eq + 1).trim() };
  });
  return params.length ? { id, params } : { id };
}

export const modelLabel = model => !model ? "account default model" : model.params?.length ? `${model.id}:${model.params.map(p => `${p.id}=${p.value}`).join(",")}` : model.id;

export function toolsForAccess(access, allowLocalWrites) {
  switch (access ?? "read-only") {
    case "read-only": return READ_ONLY_TOOLS;
    case "no-tools": return [];
    case "full":
      if (!allowLocalWrites) {
        throw new BridgeError('access "full" lets the Cursor agent edit files and run commands on this machine. It stays off unless the server runs with CURSOR_BRIDGE_ALLOW_LOCAL_WRITES=true (plugin setting "Allow local write access").');
      }
      return undefined;
    default:
      throw new BridgeError(`Unknown access "${access}". Use ${ACCESS_LEVELS.join(", ")}.`);
  }
}

// The SDK does not persist tool restrictions on an agent, so these options are rebuilt on every create and resume.
const localAgentOptions = (cwd, tools, loadProjectRules) => ({
  ...(tools ? { tools } : {}),
  local: { cwd, ...(loadProjectRules ? { settingSources: ["project"] } : {}) },
});

// Cursor wants https URLs: convert SSH remotes and strip credentials embedded in https remotes so they never leave the machine.
export function normalizeRepoUrl(url) {
  const ssh = url.match(/^(?:ssh:\/\/)?git@([^:/]+)[:/](.+?)(?:\.git)?\/?$/);
  if (ssh) return `https://${ssh[1]}/${ssh[2]}`;
  return url.replace(/^(https?:\/\/)[^@/]+@/, "$1").replace(/\.git\/?$/, "");
}

const git = (cwd, args) => {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true }).trim();
  } catch {
    return undefined;
  }
};

export function cloudRepos({ repoUrl, ref, noRepo, cwd }, warnings) {
  if (noRepo) return [];
  if (repoUrl) return [{ url: normalizeRepoUrl(repoUrl), ...(ref ? { startingRef: ref } : {}) }];
  const origin = git(cwd, ["remote", "get-url", "origin"]);
  if (!origin) throw new BridgeError(`No repo_url given and ${cwd} has no git "origin" remote. Pass repo_url, or no_repo: true.`);
  let startingRef = ref ?? git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (startingRef === "HEAD") startingRef = git(cwd, ["rev-parse", "HEAD"]);
  if (!ref) {
    const dirty = git(cwd, ["status", "--porcelain"]);
    if (dirty) warnings.push(`${dirty.split("\n").length} uncommitted file(s) in ${cwd} are not visible to the cloud agent.`);
    const ahead = git(cwd, ["rev-list", "--count", "@{u}..HEAD"]);
    if (ahead === undefined) warnings.push(`Branch ${startingRef} has no upstream, so the cloud agent may not find it on the remote.`);
    else if (Number(ahead) > 0) warnings.push(`${ahead} local commit(s) on ${startingRef} are not pushed and not visible to the cloud agent.`);
  }
  return [{ url: normalizeRepoUrl(origin), ...(startingRef ? { startingRef } : {}) }];
}

export function resolveCwd(cwd, config) {
  const dir = resolve(cwd ?? config.projectDir ?? process.cwd());
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new BridgeError(`Folder not found: ${dir}`);
  return dir;
}

export const runtimeOf = agentId => agentId.startsWith("bc-") ? "cloud" : "local";

/** Remembers how each agent was created so follow-ups reuse its folder, access level and model. */
export class StateStore {
  constructor(dataDir) {
    this.dir = join(dataDir, "agents");
  }

  #file(agentId) {
    return join(this.dir, `${agentId.replace(/[^\w.-]/g, "_")}.json`);
  }

  get(agentId) {
    try {
      return JSON.parse(readFileSync(this.#file(agentId), "utf8"));
    } catch {
      return undefined;
    }
  }

  put(record) {
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(this.#file(record.agentId), JSON.stringify(record, null, 2));
    return record;
  }

  recent(limit = 10) {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir).filter(f => f.endsWith(".json"))
      .map(f => { try { return JSON.parse(readFileSync(join(this.dir, f), "utf8")); } catch { return undefined; } })
      .filter(Boolean)
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
      .slice(0, limit);
  }
}

export const clampWait = seconds => Math.max(0, Math.min(MAX_WAIT_SECONDS, Math.round(Number.isFinite(seconds) ? seconds : DEFAULT_WAIT_SECONDS)));

export function formatDuration(ms) {
  if (!Number.isFinite(ms)) return "unknown time";
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

const count = n => Number(n ?? 0).toLocaleString("en-US");
const clip = (text, max) => text.length <= max ? text : `${text.slice(0, Math.floor(max / 2) - 2)}...${text.slice(-(Math.ceil(max / 2) - 1))}`;
// Only used as a fallback in races, so it must not keep the process alive on its own.
const sleep = ms => new Promise(r => setTimeout(r, ms).unref());
const compact = obj => Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
const isSettled = entry => entry.result !== undefined || entry.error !== undefined;
const day = ms => new Date(ms).toISOString().slice(0, 10);

export function describeError(error) {
  const message = error?.message ?? String(error);
  // Cursor messages often already carry their code in brackets; don't repeat it.
  const code = error?.code && !message.includes(`[${error.code}]`) ? ` [${error.code}]` : "";
  const repo = message.match(/does not have access to repository (\S+)/i)?.[1]?.replace(/[.,;:]+$/, "");
  let hint = "";
  if (error?.name === "AuthenticationError" || error?.code === "unauthenticated") hint = ' Sign in with cursor_auth (action "login") or set an API key in the plugin settings or CURSOR_API_KEY.';
  else if (error?.name === "IntegrationNotConnectedError") hint = ` Connect ${error.provider} to Cursor: ${error.helpUrl}`;
  else if (repo || error?.code === "repository_access") {
    hint = ` Cursor's git integration cannot see ${repo ?? "that repository"}. Grant it access (on GitHub: Settings > Applications > Installed GitHub Apps > Cursor > Configure > Repository access), or use a repository Cursor can already see.`;
  }
  else if (error?.name === "AgentBusyError") hint = " That agent still has an active run; use cursor_wait or cursor_cancel.";
  else if (error?.name === "RateLimitError") hint = " Cursor rate limited the request; wait a minute and retry.";
  else if (error?.code === "feature_unavailable") hint = " Cursor does not offer this for the account behind the API key.";
  return `${message}${code}${hint}`;
}

async function dispose(agent) {
  if (!agent) return;
  try {
    await Promise.race([agent[Symbol.asyncDispose]?.(), sleep(5000)]);
  } catch { /* best effort */ }
}

async function followActivity(entry) {
  try {
    for await (const message of entry.run.stream()) {
      if (message.type !== "tool_call" || message.status === "running") continue;
      entry.activity.push(`${message.name}${message.status === "error" ? " (failed)" : ""} ${clip(JSON.stringify(message.args ?? {}), 120)}`);
      if (entry.activity.length > 20) entry.activity.shift();
    }
  } catch { /* activity is best effort; wait() still reports the outcome */ }
}

/** Waits for `promise` up to `seconds`, stopping early if the client cancels, and sends progress updates when asked to. */
async function waitWithProgress(promise, seconds, extra, describe) {
  const token = extra?._meta?.progressToken;
  const started = Date.now();
  let timer, ticker, onAbort;
  const timeout = new Promise(r => { timer = setTimeout(r, seconds * 1000); });
  const aborted = new Promise(r => { onAbort = r; extra?.signal?.addEventListener("abort", r, { once: true }); });
  if (token !== undefined && extra?.sendNotification) {
    ticker = setInterval(() => {
      const progress = Math.round((Date.now() - started) / 1000);
      extra.sendNotification({ method: "notifications/progress", params: { progressToken: token, progress, message: describe() } }).catch(() => {});
    }, 10_000);
  }
  try {
    await Promise.race([promise, timeout, aborted]);
  } finally {
    clearTimeout(timer);
    clearInterval(ticker);
    extra?.signal?.removeEventListener?.("abort", onAbort);
  }
}

export function formatEntry(entry, now = Date.now()) {
  const ids = [`agent_id: ${entry.agentId}${entry.name ? ` ("${entry.name}")` : ""}`, `run_id: ${entry.runId}`, ...(entry.url ? [`watch: ${entry.url}`] : [])];
  const warnings = entry.warnings.map(w => `warning: ${w}`);
  const where = [entry.runtime, entry.runtime === "local" ? entry.access : undefined].filter(Boolean).join(", ");
  if (!isSettled(entry)) {
    const lines = [`Cursor agent still running (${where}, ${formatDuration(now - entry.startedAt)} so far).`, ...ids];
    if (entry.activity.length) lines.push("Recent activity:", ...entry.activity.slice(-5).map(a => `- ${a}`));
    lines.push(...warnings, "Call cursor_wait with this agent_id to keep waiting, or cursor_cancel to stop the run.");
    return { text: lines.join("\n") };
  }
  if (entry.error !== undefined) return { isError: true, text: [`Cursor run failed: ${describeError(entry.error)}`, ...ids].join("\n") };
  const r = entry.result;
  const status = entry.hitTimeLimit && r.status === "cancelled" ? "cancelled after hitting the max run time" : r.status;
  const lines = [`Cursor agent ${status} (${where}, ${modelLabel(r.model ?? entry.model)}, agent ran ${formatDuration(r.durationMs)}).`, ...ids, "", r.result?.trim() || "(no final message)", "", "---"];
  if (r.error) lines.push(`error: ${r.error.message}${r.error.code ? ` [${r.error.code}]` : ""}`);
  if (r.usage) lines.push(`tokens: ${count(r.usage.totalTokens)} total (input ${count(r.usage.inputTokens)}, cached input ${count(r.usage.cacheReadTokens)}, output ${count(r.usage.outputTokens)})`);
  for (const b of r.git?.branches ?? []) lines.push(`branch: ${b.branch ?? "none"} on ${b.repoUrl}${b.prUrl ? `, PR ${b.prUrl}` : ""}`);
  lines.push(...warnings);
  return { isError: r.status === "error", text: lines.join("\n") };
}

const loginPrompt = login => login.url
  ? `Sign in to Cursor in the browser window that opened, or open this link:\n${login.url}\nAfter signing in, call cursor_auth with action "login" again to confirm; it waits for the sign-in to finish.`
  : 'Started the Cursor sign-in, but no login link is available yet. Call cursor_auth with action "login" again in a moment.';

export class CursorBridge {
  #live = new Map();
  #login;

  constructor({ env = process.env, sdk = { Agent, Cursor }, readUserEnv = readWindowsUserEnvKey } = {}) {
    this.env = env;
    this.sdk = sdk;
    this.readUserEnv = readUserEnv;
    this.config = loadConfig(env);
    this.state = new StateStore(this.config.dataDir);
  }

  #apiKey() {
    return resolveApiKey(this.env, this.readUserEnv);
  }

  #keySource() {
    return resolveApiKeySource(this.env, this.readUserEnv);
  }

  async runLocal(args, extra) {
    const cwd = resolveCwd(args.cwd, this.config);
    const model = args.model ? parseModelSpec(args.model) : this.config.defaultModel;
    const access = args.access ?? "read-only";
    const loadProjectRules = args.loadProjectRules ?? true;
    const tools = toolsForAccess(access, this.config.allowLocalWrites);
    const agent = await this.sdk.Agent.create({ apiKey: this.#apiKey(), model, ...(args.name ? { name: args.name } : {}), ...localAgentOptions(cwd, tools, loadProjectRules) });
    const record = { agentId: agent.agentId, runtime: "local", name: args.name ?? null, cwd, access, loadProjectRules, model, createdAt: new Date().toISOString() };
    return this.#start(agent, record, args.prompt, { mode: args.mode }, args.waitSeconds, extra, []);
  }

  async runCloud(args, extra) {
    const warnings = [];
    const cwd = args.noRepo || args.repoUrl ? undefined : resolveCwd(args.cwd, this.config);
    const repos = cloudRepos({ repoUrl: args.repoUrl, ref: args.ref, noRepo: args.noRepo, cwd }, warnings);
    const model = args.model ? parseModelSpec(args.model) : this.config.defaultModel;
    const createPr = args.createPr === true;
    // workOnCurrentBranch stays false: the agent always pushes to its own cursor/... branch, never to the starting ref.
    const agent = await this.sdk.Agent.create({ apiKey: this.#apiKey(), model, ...(args.name ? { name: args.name } : {}), cloud: { repos, workOnCurrentBranch: false, autoCreatePR: createPr } });
    const record = { agentId: agent.agentId, runtime: "cloud", name: args.name ?? null, repos, createPr, model, createdAt: new Date().toISOString() };
    return this.#start(agent, record, args.prompt, { mode: args.mode }, args.waitSeconds, extra, warnings);
  }

  async followup(args, extra) {
    const { agentId } = args;
    const active = this.#latestLive(agentId);
    if (active && !isSettled(active)) throw new BridgeError(`Agent ${agentId} is still working on run ${active.runId}. Use cursor_wait or cursor_cancel first.`);
    const saved = this.state.get(agentId);
    const runtime = runtimeOf(agentId);
    const apiKey = this.#apiKey();
    const model = args.model ? parseModelSpec(args.model) : saved?.model ?? this.config.defaultModel;
    const send = { mode: args.mode, ...(args.model ? { model } : {}) };
    let record = { ...(saved ?? { agentId, runtime, name: null, createdAt: new Date().toISOString() }), model };
    let resume = { apiKey };
    if (runtime === "local") {
      const cwd = resolveCwd(args.cwd ?? saved?.cwd, this.config);
      const access = saved?.access ?? "read-only";
      const loadProjectRules = saved?.loadProjectRules ?? true;
      resume = { apiKey, model, ...localAgentOptions(cwd, toolsForAccess(access, this.config.allowLocalWrites), loadProjectRules) };
      record = { ...record, cwd, access, loadProjectRules };
      // A local run that an earlier server process left "running" can never finish; force expires it so this message can start.
      if (!active) send.local = { force: true };
    }
    const agent = await this.sdk.Agent.resume(agentId, resume);
    return this.#start(agent, record, args.prompt, send, args.waitSeconds, extra, []);
  }

  async wait(args, extra) {
    const entry = args.runId ? this.#live.get(args.runId) : this.#latestLive(args.agentId);
    if (entry) return this.#waitAndReport(entry, args.waitSeconds, extra);
    const saved = this.state.get(args.agentId);
    const runId = args.runId ?? saved?.lastRunId;
    if (!runId) throw new BridgeError(`No run on record for agent ${args.agentId}. Pass run_id.`);
    const runtime = runtimeOf(args.agentId);
    const run = await this.sdk.Agent.getRun(runId, this.#runLookup(args.agentId, runtime, saved?.cwd));
    // Local runs execute inside the process that started them, so one still marked running belongs to a process that has exited.
    if (runtime === "local" && run.status === "running") {
      return { isError: true, text: `Local run ${runId} is marked running, but the server process that started it has exited, so it will not finish. Send cursor_followup to agent ${args.agentId} to continue; that expires the stale run.` };
    }
    return this.#waitAndReport(this.#track(run, { runtime, model: saved?.model, access: saved?.access, name: saved?.name }), args.waitSeconds, extra);
  }

  async status(args) {
    if (!args.agentId) {
      const running = [...this.#live.values()].filter(e => !isSettled(e));
      const lines = [running.length ? "Running in this server:" : "No runs in progress in this server."];
      for (const e of running) lines.push(`- ${e.agentId} (${e.runtime}), run ${e.runId}, ${formatDuration(Date.now() - e.startedAt)} so far`);
      const recent = this.state.recent(10);
      if (recent.length) {
        lines.push("", "Recent agents:");
        for (const r of recent) lines.push(`- ${r.agentId} (${r.runtime}${r.name ? `, "${r.name}"` : ""}${r.cwd ? `, ${r.cwd}` : ""}), last run ${r.lastRunId}, updated ${r.updatedAt}`);
      }
      return { text: lines.join("\n") };
    }
    const saved = this.state.get(args.agentId);
    const runtime = runtimeOf(args.agentId);
    const options = runtime === "cloud" ? { runtime, apiKey: this.#apiKey(), limit: 5 } : { runtime, cwd: resolveCwd(saved?.cwd, this.config), limit: 5 };
    const { items } = await this.sdk.Agent.listRuns(args.agentId, options);
    const lines = [`Agent ${args.agentId} (${runtime}${saved?.name ? `, "${saved.name}"` : ""}${saved?.cwd ? `, ${saved.cwd}` : ""})`];
    if (!items.length) lines.push("No runs found.");
    for (const run of [...items].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))) {
      const live = this.#live.get(run.id);
      const status = live && !isSettled(live) ? "running" : run.status;
      lines.push(`- ${run.id}: ${status}${run.durationMs ? `, ${formatDuration(run.durationMs)}` : ""}${run.createdAt ? `, started ${new Date(run.createdAt).toISOString()}` : ""}`);
    }
    lines.push("", "cursor_wait returns a run's reply.");
    return { text: lines.join("\n") };
  }

  async cancel(args) {
    const entry = args.runId ? this.#live.get(args.runId) : this.#latestLive(args.agentId);
    if (entry) {
      if (isSettled(entry)) return { text: `Run ${entry.runId} already ended (${entry.result?.status ?? "failed"}); nothing to cancel.` };
      await entry.run.cancel();
      await Promise.race([entry.done, sleep(5000)]);
      return { text: `Cancelled run ${entry.runId} of agent ${entry.agentId}.` };
    }
    const saved = this.state.get(args.agentId);
    const runId = args.runId ?? saved?.lastRunId;
    if (!runId) throw new BridgeError(`No run on record for agent ${args.agentId}. Pass run_id.`);
    await this.sdk.Agent.cancelRun(runId, this.#runLookup(args.agentId, runtimeOf(args.agentId), saved?.cwd));
    return { text: `Cancel requested for run ${runId} of agent ${args.agentId}.` };
  }

  async models() {
    const configured = this.#keySource();
    const apiKey = configured?.key;
    const [me, models] = await Promise.all([this.sdk.Cursor.me({ apiKey }), this.sdk.Cursor.models.list({ apiKey })]);
    const lines = [
      `API key "${me.apiKeyName}" works (from ${configured?.source ?? "the stored Cursor sign-in"}).`,
      `Server default model: ${modelLabel(this.config.defaultModel)}. Local write access: ${this.config.allowLocalWrites ? "allowed" : "off"}.`,
      "",
      "Models (pass as model; params go after a colon, e.g. grok-4.6:effort=high):",
    ];
    for (const m of models) {
      const params = (m.parameters ?? []).map(p => `${p.id}=${p.values.map(v => v.value).join("|")}`).join(" ");
      lines.push(`- ${m.id}: ${m.displayName}${params ? ` [${params}]` : ""}`);
    }
    return { text: lines.join("\n") };
  }

  async auth({ action = "status", waitSeconds } = {}, extra) {
    if (!AUTH_ACTIONS.includes(action)) throw new BridgeError(`Unknown action "${action}". Use ${AUTH_ACTIONS.join(", ")}.`);
    if (action === "logout") {
      await this.sdk.Cursor.auth.logout();
      this.#login = undefined;
      return { text: "Removed the stored Cursor sign-in from this machine. The key it created stays valid until it expires; revoke it at Cursor Dashboard > API Keys if needed." };
    }
    if (action === "login") return this.#signIn(waitSeconds, extra);
    const configured = this.#keySource();
    const stored = await this.sdk.Cursor.auth.status();
    const lines = [];
    if (configured) lines.push(`Using the API key from ${configured.source}. cursor_models checks that it works.`);
    if (stored.status === "logged-in") {
      const who = stored.email ? ` as ${stored.email}` : "";
      const expires = stored.apiKeyExpiresAtMs ? `; its key expires ${day(stored.apiKeyExpiresAtMs)}` : "";
      lines.push(`${configured ? "A Cursor browser sign-in is also stored" : "Signed in with Cursor"}${who}${expires}.${configured ? " The configured API key takes precedence." : ""}`);
    }
    if (this.#login && !this.#login.settled) lines.push(`A sign-in is in progress: ${this.#login.url ?? "waiting for the login link"}`);
    if (!lines.length) lines.push('Not signed in. Call cursor_auth with action "login" to sign in with a Cursor account in the browser, or set an API key in the plugin settings.');
    return { text: lines.join("\n") };
  }

  async shutdown() {
    // Local runs live inside this process and end with it anyway; cloud runs keep going and cursor_wait can pick them up later.
    const local = [...this.#live.values()].filter(e => e.runtime === "local" && !isSettled(e));
    await Promise.allSettled(local.map(e => e.run.cancel()));
  }

  async #signIn(waitSeconds, extra) {
    let login = this.#login;
    if (login && !login.settled) {
      const seconds = clampWait(waitSeconds);
      if (seconds > 0) await waitWithProgress(login.done, seconds, extra, () => "Waiting for the Cursor sign-in in the browser");
    } else if (!login?.result) {
      // Starting a sign-in opens a browser window, so never start one while a sign-in is already stored.
      const stored = await this.sdk.Cursor.auth.status();
      if (stored.status === "logged-in") {
        return { text: `Already signed in with Cursor${stored.email ? ` as ${stored.email}` : ""}. To switch accounts, call cursor_auth with action "logout" first.` };
      }
      let announce;
      const linkReady = new Promise(r => { announce = r; });
      login = { startedAt: Date.now() };
      login.done = this.sdk.Cursor.auth.login({ apiKeyName: `cursor-bridge on ${hostname()}`, onLoginUrl: url => { login.url = url; announce(); } })
        // Keep only what is safe to show: the minted key itself never leaves the SDK's credential store.
        .then(result => { login.result = { email: result.email, expiresAtMs: result.apiKeyExpiresAtMs }; }, error => { login.error = error ?? new Error("sign-in failed"); })
        .finally(() => { login.settled = true; announce(); });
      this.#login = login;
      await Promise.race([linkReady, sleep(15_000)]);
    }
    if (login.error !== undefined) return { isError: true, text: `Cursor sign-in failed: ${describeError(login.error)}` };
    if (login.result) {
      const who = login.result.email ? ` as ${login.result.email}` : "";
      const expires = login.result.expiresAtMs ? ` Its key expires ${day(login.result.expiresAtMs)}.` : "";
      const configured = this.#keySource();
      const note = configured ? ` The API key from ${configured.source} still takes precedence over this sign-in.` : "";
      return { text: `Signed in with Cursor${who}. The key is stored on this machine in ~/.cursor/sdk/auth.json.${expires}${note}` };
    }
    return { text: loginPrompt(login) };
  }

  async #start(agent, record, prompt, send, waitSeconds, extra, warnings) {
    let run;
    try {
      run = await agent.send(prompt, compact(send));
    } catch (error) {
      await dispose(agent);
      throw error;
    }
    this.state.put({ ...record, lastRunId: run.id, updatedAt: new Date().toISOString() });
    const entry = this.#track(run, { agent, runtime: record.runtime, model: record.model, access: record.access, name: record.name, warnings });
    return this.#waitAndReport(entry, waitSeconds, extra);
  }

  #track(run, { agent, runtime, model, access, name, warnings = [] }) {
    const entry = {
      run, agentId: run.agentId, runId: run.id, runtime, model, access, name, warnings, startedAt: Date.now(), activity: [],
      url: runtime === "cloud" ? `https://cursor.com/agents/${run.agentId}` : null,
    };
    this.#live.set(run.id, entry);
    if (run.supports?.("stream")) void followActivity(entry);
    const limitMs = this.config.maxRunMinutes * 60_000;
    const limit = limitMs > 0 ? setTimeout(() => { entry.hitTimeLimit = true; run.cancel().catch(() => {}); }, limitMs) : undefined;
    limit?.unref?.();
    entry.done = Promise.resolve()
      .then(() => run.wait())
      .then(result => { entry.result = result; }, error => { entry.error = error ?? new Error("run failed"); })
      .finally(async () => {
        clearTimeout(limit);
        entry.settledAt = Date.now();
        await dispose(agent);
        this.#prune();
      });
    return entry;
  }

  async #waitAndReport(entry, waitSeconds, extra) {
    const seconds = clampWait(waitSeconds);
    if (!isSettled(entry) && seconds > 0) {
      await waitWithProgress(entry.done, seconds, extra, () => {
        const last = entry.activity.at(-1);
        return `Cursor agent running ${formatDuration(Date.now() - entry.startedAt)}${last ? `, last: ${last}` : ""}`;
      });
    }
    return formatEntry(entry);
  }

  #latestLive(agentId) {
    let latest;
    for (const entry of this.#live.values()) if (entry.agentId === agentId && (!latest || entry.startedAt > latest.startedAt)) latest = entry;
    return latest;
  }

  #runLookup(agentId, runtime, cwd) {
    return runtime === "cloud" ? { runtime, agentId, apiKey: this.#apiKey() } : { runtime, cwd: resolveCwd(cwd, this.config) };
  }

  #prune() {
    const cutoff = Date.now() - SETTLED_RUN_TTL_MS;
    for (const [id, entry] of this.#live) if (entry.settledAt && entry.settledAt < cutoff) this.#live.delete(id);
  }
}
