// Unit tests for the bridge core. A fake @cursor/sdk stands in for the real one, so nothing here touches the network.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import {
  BridgeError, clampWait, cloudRepos, CursorBridge, describeError, envValue, FALLBACK_MODEL, formatDuration, loadConfig, normalizeRepoUrl,
  parseModelSpec, READ_ONLY_TOOLS, resolveApiKey, resolveApiKeySource, toolsForAccess,
} from "../server/bridge.mjs";

const tempDirs = [];
const tempDir = () => { const dir = mkdtempSync(join(tmpdir(), "cursor-bridge-test-")); tempDirs.push(dir); return dir; };
after(() => { for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true }); });

function fakeSdk({ autoFinish = true } = {}) {
  const calls = { create: [], resume: [], send: [], cancelRun: [], login: [], logout: 0 };
  const runs = [];
  let seq = 0;
  const makeRun = agentId => {
    let settle, reject;
    const done = new Promise((res, rej) => { settle = res; reject = rej; });
    const run = {
      id: `run-${++seq}`, agentId, status: "running", supports: () => false, wait: () => done,
      cancel: async () => { run.status = "cancelled"; settle({ id: run.id, status: "cancelled", durationMs: 5 }); },
      finish: text => { run.status = "finished"; settle({ id: run.id, status: "finished", result: text, durationMs: 61_000, usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 2, cacheWriteTokens: 0, totalTokens: 17 } }); },
      fail: error => reject(error),
    };
    runs.push(run);
    return run;
  };
  const makeAgent = agentId => ({
    agentId,
    send: async (prompt, options) => {
      calls.send.push({ agentId, prompt, options });
      const run = makeRun(agentId);
      if (autoFinish) run.finish(`reply to: ${prompt}`);
      return run;
    },
    [Symbol.asyncDispose]: async () => {},
  });
  const sdk = {
    Agent: {
      create: async options => { calls.create.push(options); return makeAgent(options.cloud ? `bc-${++seq}` : `agent-${++seq}`); },
      resume: async (agentId, options) => { calls.resume.push({ agentId, options }); return makeAgent(agentId); },
      getRun: async () => { throw new Error("getRun not stubbed"); },
      listRuns: async () => ({ items: [] }),
      cancelRun: async (runId, options) => { calls.cancelRun.push({ runId, options }); },
    },
    Cursor: {
      me: async () => ({ apiKeyName: "test key" }),
      models: { list: async () => [{ id: "composer-2.5", displayName: "Composer 2.5", parameters: [{ id: "fast", values: [{ value: "false" }, { value: "true" }] }] }] },
      auth: {
        state: { status: "logged-out" },
        status: async () => sdk.Cursor.auth.state,
        logout: async () => { calls.logout++; sdk.Cursor.auth.state = { status: "logged-out" }; },
        // Mirrors the SDK: announce the login link, then resolve once the browser sign-in completes.
        login: async options => {
          calls.login.push(options);
          options.onLoginUrl?.("https://cursor.com/loginDeepControl?uuid=test");
          await new Promise(r => { sdk.Cursor.auth.completeSignIn = r; });
          const expires = Date.UTC(2026, 11, 15);
          sdk.Cursor.auth.state = { status: "logged-in", email: "dev@example.com", apiKeyExpiresAtMs: expires };
          return { apiKey: "minted-secret-key", email: "dev@example.com", apiKeyExpiresAtMs: expires };
        },
      },
    },
  };
  return { sdk, calls, runs };
}

// readUserEnv is stubbed so tests never read a real key from the Windows user environment.
const newBridge = (sdk, env = {}, { withKey = true } = {}) => {
  const dir = tempDir();
  const key = withKey ? { CURSOR_API_KEY: "test-key" } : {};
  return new CursorBridge({ sdk, env: { ...key, CURSOR_BRIDGE_DATA_DIR: dir, CLAUDE_PROJECT_DIR: dir, ...env }, readUserEnv: () => undefined });
};

describe("parsing and config", () => {
  test("parseModelSpec handles ids and params", () => {
    assert.deepEqual(parseModelSpec("grok-4.6"), { id: "grok-4.6" });
    assert.deepEqual(parseModelSpec(" grok-4.6:effort=high, fast=true, "), { id: "grok-4.6", params: [{ id: "effort", value: "high" }, { id: "fast", value: "true" }] });
    assert.throws(() => parseModelSpec(":effort=high"), BridgeError);
    assert.throws(() => parseModelSpec("grok-4.6:effort"), BridgeError);
  });

  test("envValue ignores unexpanded plugin placeholders", () => {
    assert.equal(envValue({ K: "${user_config.cursor_api_key}" }, "K"), undefined);
    assert.equal(envValue({ K: "  " }, "K"), undefined);
    assert.equal(envValue({ K: " abc " }, "K"), "abc");
  });

  test("resolveApiKey prefers the plugin setting but falls back to an inherited CURSOR_API_KEY", () => {
    assert.equal(resolveApiKey({ CURSOR_BRIDGE_API_KEY: "from-plugin", CURSOR_API_KEY: "from-env" }), "from-plugin");
    assert.equal(resolveApiKey({ CURSOR_BRIDGE_API_KEY: "", CURSOR_API_KEY: "from-env" }), "from-env");
    assert.equal(resolveApiKey({ CURSOR_BRIDGE_API_KEY: "${user_config.cursor_api_key}", CLAUDE_PLUGIN_OPTION_CURSOR_API_KEY: "from-option" }), "from-option");
  });

  test("resolveApiKeySource names where the key came from", () => {
    const none = () => undefined;
    assert.equal(resolveApiKeySource({ CURSOR_BRIDGE_API_KEY: "a" }, none).source, "the plugin setting");
    assert.equal(resolveApiKeySource({ CURSOR_API_KEY: "b" }, none).source, "the CURSOR_API_KEY environment variable");
    assert.equal(resolveApiKeySource({ CLAUDE_PLUGIN_OPTION_CURSOR_API_KEY: "c" }, none).source, "the plugin setting");
    const registry = resolveApiKeySource({ CURSOR_BRIDGE_API_KEY: "" }, () => "from-registry");
    assert.deepEqual(registry, { key: "from-registry", source: "the CURSOR_API_KEY Windows user environment variable (read from the registry)" });
    assert.equal(resolveApiKeySource({}, none), undefined);
  });

  test("describeError explains missing repository access without repeating the code", () => {
    const error = Object.assign(new Error("[validation_error] The SCM integration does not have access to repository zzzare/cursor-bridge to verify branch existence."), { code: "validation_error" });
    const text = describeError(error);
    assert.match(text, /Cursor's git integration cannot see zzzare\/cursor-bridge\. Grant it access/);
    assert.equal(text.split("[validation_error]").length - 1, 1);
    assert.match(describeError(Object.assign(new Error("no access"), { code: "repository_access" })), /cannot see that repository/);
  });

  test("loadConfig defaults and overrides", () => {
    const defaults = loadConfig({});
    assert.equal(defaults.defaultModel.id, FALLBACK_MODEL);
    assert.equal(defaults.allowLocalWrites, false);
    assert.equal(defaults.maxRunMinutes, 60);
    assert.match(defaults.dataDir, /\.cursor-bridge$/);
    const plugin = loadConfig({ CLAUDE_PLUGIN_OPTION_DEFAULT_MODEL: "grok-4.6:effort=high", CLAUDE_PLUGIN_OPTION_ALLOW_LOCAL_WRITES: "true", CURSOR_BRIDGE_MAX_RUN_MINUTES: "oops" });
    assert.deepEqual(plugin.defaultModel, { id: "grok-4.6", params: [{ id: "effort", value: "high" }] });
    assert.equal(plugin.allowLocalWrites, true);
    assert.equal(plugin.maxRunMinutes, 60);
  });

  test("toolsForAccess keeps full access behind the flag", () => {
    assert.deepEqual(toolsForAccess(undefined, false), READ_ONLY_TOOLS);
    assert.deepEqual(toolsForAccess("no-tools", false), []);
    assert.throws(() => toolsForAccess("full", false), BridgeError);
    assert.equal(toolsForAccess("full", true), undefined);
    assert.throws(() => toolsForAccess("root", true), BridgeError);
  });

  test("normalizeRepoUrl converts SSH and strips credentials", () => {
    assert.equal(normalizeRepoUrl("git@github.com:org/repo.git"), "https://github.com/org/repo");
    assert.equal(normalizeRepoUrl("ssh://git@github.com/org/repo.git"), "https://github.com/org/repo");
    assert.equal(normalizeRepoUrl("https://user:token@github.com/org/repo.git"), "https://github.com/org/repo");
    assert.equal(normalizeRepoUrl("https://github.com/org/repo"), "https://github.com/org/repo");
  });

  test("clampWait and formatDuration", () => {
    assert.equal(clampWait(undefined), 110);
    assert.equal(clampWait(-5), 0);
    assert.equal(clampWait(99999), 1800);
    assert.equal(formatDuration(55_631), "56s");
    assert.equal(formatDuration(125_000), "2m 5s");
    assert.equal(formatDuration(undefined), "unknown time");
  });

  test("cloudRepos uses explicit repo or infers it from git with warnings", () => {
    assert.deepEqual(cloudRepos({ noRepo: true }, []), []);
    assert.deepEqual(cloudRepos({ repoUrl: "git@github.com:o/r.git", ref: "main" }, []), [{ url: "https://github.com/o/r", startingRef: "main" }]);
    const repo = tempDir();
    execFileSync("git", ["init", "-q"], { cwd: repo });
    execFileSync("git", ["remote", "add", "origin", "https://someone:secret@github.com/o/r.git"], { cwd: repo });
    writeFileSync(join(repo, "untracked.txt"), "x");
    const warnings = [];
    const [inferred] = cloudRepos({ cwd: repo }, warnings);
    assert.equal(inferred.url, "https://github.com/o/r");
    assert.ok(warnings.some(w => w.includes("uncommitted")), warnings.join(" | "));
    assert.ok(warnings.some(w => w.includes("upstream")), warnings.join(" | "));
  });
});

describe("CursorBridge with a fake SDK", () => {
  test("runLocal is read-only by default and returns the final reply", async () => {
    const { sdk, calls } = fakeSdk();
    const bridge = newBridge(sdk);
    const out = await bridge.runLocal({ prompt: "review it", waitSeconds: 5 });
    const created = calls.create[0];
    assert.deepEqual(created.tools, READ_ONLY_TOOLS);
    assert.deepEqual(created.local.settingSources, ["project"]);
    assert.equal(created.model.id, FALLBACK_MODEL);
    assert.equal(created.apiKey, "test-key");
    assert.ok(!out.isError);
    assert.match(out.text, /Cursor agent finished \(local, read-only, composer-2\.5, agent ran 1m 1s\)/);
    assert.match(out.text, /reply to: review it/);
    assert.match(out.text, /tokens: 17 total/);
    const agentId = out.text.match(/agent_id: (\S+)/)[1];
    const saved = bridge.state.get(agentId);
    assert.equal(saved.access, "read-only");
    assert.ok(saved.lastRunId);
  });

  test("runLocal refuses full access unless allowed, before creating an agent", async () => {
    const { sdk, calls } = fakeSdk();
    await assert.rejects(newBridge(sdk).runLocal({ prompt: "x", access: "full" }), BridgeError);
    assert.equal(calls.create.length, 0);
    const out = await newBridge(sdk, { CURSOR_BRIDGE_ALLOW_LOCAL_WRITES: "1" }).runLocal({ prompt: "x", access: "full", waitSeconds: 5 });
    assert.equal(calls.create[0].tools, undefined);
    assert.match(out.text, /finished/);
  });

  test("a slow run returns its ids, then cursor_wait and cancel work on it", async () => {
    const { sdk, runs } = fakeSdk({ autoFinish: false });
    const bridge = newBridge(sdk);
    const started = await bridge.runLocal({ prompt: "slow", waitSeconds: 0 });
    assert.match(started.text, /still running/);
    const agentId = started.text.match(/agent_id: (\S+)/)[1];
    setTimeout(() => runs[0].finish("done late"), 50);
    const waited = await bridge.wait({ agentId, waitSeconds: 5 });
    assert.match(waited.text, /done late/);
    assert.match((await bridge.cancel({ agentId })).text, /already ended/);

    const second = await bridge.runLocal({ prompt: "another", waitSeconds: 0 });
    const secondId = second.text.match(/agent_id: (\S+)/)[1];
    assert.match((await bridge.cancel({ agentId: secondId })).text, /Cancelled run/);
    assert.match((await bridge.wait({ agentId: secondId, waitSeconds: 0 })).text, /Cursor agent cancelled/);
  });

  test("followup re-applies the saved folder and read-only tools, and expires stale runs after a restart", async () => {
    const { sdk, calls } = fakeSdk();
    const bridge = newBridge(sdk);
    const first = await bridge.runLocal({ prompt: "one", model: "grok-4.6:effort=low", loadProjectRules: false, name: "reviewer", waitSeconds: 5 });
    const agentId = first.text.match(/agent_id: (\S+)/)[1];

    const second = await bridge.followup({ agentId, prompt: "two", waitSeconds: 5 });
    assert.match(second.text, /\(local, read-only, grok-4\.6:effort=low, agent ran/, "follow-up output shows the access level it kept");
    assert.match(second.text, /agent_id: \S+ \("reviewer"\)/);
    const resumed = calls.resume[0].options;
    assert.deepEqual(resumed.tools, READ_ONLY_TOOLS);
    assert.equal(resumed.local.cwd, bridge.state.get(agentId).cwd);
    assert.equal(resumed.local.settingSources, undefined);
    assert.deepEqual(resumed.model, { id: "grok-4.6", params: [{ id: "effort", value: "low" }] });
    assert.equal(calls.send.at(-1).options.local, undefined, "no force while this process knows the previous run");

    const restarted = new CursorBridge({ sdk, env: bridge.env });
    await restarted.followup({ agentId, prompt: "three", waitSeconds: 5 });
    assert.deepEqual(calls.send.at(-1).options.local, { force: true });
    assert.deepEqual(calls.resume.at(-1).options.tools, READ_ONLY_TOOLS);
  });

  test("followup is refused while the agent is still running", async () => {
    const { sdk } = fakeSdk({ autoFinish: false });
    const bridge = newBridge(sdk);
    const started = await bridge.runLocal({ prompt: "slow", waitSeconds: 0 });
    const agentId = started.text.match(/agent_id: (\S+)/)[1];
    await assert.rejects(bridge.followup({ agentId, prompt: "more" }), /still working/);
  });

  test("runCloud never works on the starting branch and opens PRs only on request", async () => {
    const { sdk, calls } = fakeSdk();
    const bridge = newBridge(sdk);
    const out = await bridge.runCloud({ prompt: "fix", repoUrl: "https://github.com/o/r.git", ref: "main", waitSeconds: 5 });
    assert.deepEqual(calls.create[0].cloud, { repos: [{ url: "https://github.com/o/r", startingRef: "main" }], workOnCurrentBranch: false, autoCreatePR: false });
    assert.match(out.text, /watch: https:\/\/cursor\.com\/agents\/bc-/);
    await bridge.runCloud({ prompt: "fix", repoUrl: "https://github.com/o/r", createPr: true, waitSeconds: 5 });
    assert.equal(calls.create[1].cloud.autoCreatePR, true);
    assert.equal(calls.create[1].tools, undefined);
  });

  test("wait reports a local run orphaned by an earlier process instead of hanging", async () => {
    const { sdk } = fakeSdk();
    const bridge = newBridge(sdk);
    bridge.state.put({ agentId: "agent-old", runtime: "local", cwd: bridge.config.projectDir, lastRunId: "run-old", updatedAt: new Date().toISOString() });
    sdk.Agent.getRun = async () => ({ id: "run-old", agentId: "agent-old", status: "running", supports: () => false, wait: () => new Promise(() => {}) });
    const out = await bridge.wait({ agentId: "agent-old" });
    assert.equal(out.isError, true);
    assert.match(out.text, /has exited/);
    await assert.rejects(bridge.wait({ agentId: "agent-unknown" }), BridgeError);
  });

  test("a failing run is reported as an error with a hint", async () => {
    const { sdk, runs } = fakeSdk({ autoFinish: false });
    const bridge = newBridge(sdk);
    const started = bridge.runLocal({ prompt: "x", waitSeconds: 5 });
    setTimeout(() => runs[0].fail(Object.assign(new Error("API key is required"), { name: "ConfigurationError", code: "unauthenticated" })), 20);
    const out = await started;
    assert.equal(out.isError, true);
    assert.match(out.text, /Cursor run failed: API key is required \[unauthenticated\] Sign in with cursor_auth \(action "login"\) or set an API key/);
  });

  test("auth status reports a configured key, a stored sign-in, or neither", async () => {
    const { sdk } = fakeSdk();
    assert.match((await newBridge(sdk).auth()).text, /Using the API key from the CURSOR_API_KEY environment variable/);
    assert.match((await newBridge(sdk, { CURSOR_BRIDGE_API_KEY: "from-plugin" }).auth()).text, /Using the API key from the plugin setting/);
    assert.match((await newBridge(sdk, {}, { withKey: false }).auth()).text, /Not signed in/);
    sdk.Cursor.auth.state = { status: "logged-in", email: "dev@example.com", apiKeyExpiresAtMs: Date.UTC(2026, 11, 15) };
    assert.match((await newBridge(sdk, {}, { withKey: false }).auth({ action: "status" })).text, /Signed in with Cursor as dev@example\.com; its key expires 2026-12-15/);
    await assert.rejects(newBridge(sdk).auth({ action: "sudo" }), BridgeError);
  });

  test("auth login returns the link first, confirms on the next call, and never exposes the minted key", async () => {
    const { sdk, calls } = fakeSdk();
    const bridge = newBridge(sdk, {}, { withKey: false });
    const started = await bridge.auth({ action: "login" });
    assert.match(started.text, /https:\/\/cursor\.com\/loginDeepControl\?uuid=test/);
    assert.match(calls.login[0].apiKeyName, /^cursor-bridge on /);
    assert.match((await bridge.auth({ action: "status" })).text, /sign-in is in progress/);
    setTimeout(() => sdk.Cursor.auth.completeSignIn(), 20);
    const confirmed = await bridge.auth({ action: "login", waitSeconds: 5 });
    assert.match(confirmed.text, /Signed in with Cursor as dev@example\.com/);
    assert.doesNotMatch(confirmed.text, /minted-secret-key/);
    assert.match((await bridge.auth({ action: "login" })).text, /Signed in with Cursor/);
    assert.equal(calls.login.length, 1, "a finished sign-in is reported again, not restarted");
  });

  test("auth login does not open a new sign-in when one is already stored, and logout clears it", async () => {
    const { sdk, calls } = fakeSdk();
    sdk.Cursor.auth.state = { status: "logged-in", email: "dev@example.com" };
    const bridge = newBridge(sdk, {}, { withKey: false });
    assert.match((await bridge.auth({ action: "login" })).text, /Already signed in/);
    assert.equal(calls.login.length, 0);
    assert.match((await bridge.auth({ action: "logout" })).text, /Removed the stored Cursor sign-in/);
    assert.equal(calls.logout, 1);
    assert.match((await bridge.auth()).text, /Not signed in/);
  });

  test("models lists ids with params and the server default", async () => {
    const { sdk } = fakeSdk();
    const out = await newBridge(sdk, { CURSOR_BRIDGE_DEFAULT_MODEL: "grok-4.6:effort=high" }).models();
    assert.match(out.text, /API key "test key" works \(from the CURSOR_API_KEY environment variable\)/);
    assert.match(out.text, /Server default model: grok-4\.6:effort=high/);
    assert.match(out.text, /- composer-2\.5: Composer 2\.5 \[fast=false\|true\]/);
  });
});
