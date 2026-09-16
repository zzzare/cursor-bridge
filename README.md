# cursor-bridge

An MCP server and Claude Code plugin that hands tasks to [Cursor](https://cursor.com) agents and returns their final reply. Built on Cursor's official TypeScript SDK, `@cursor/sdk`.

- **Local runs** execute on your machine against a folder and see uncommitted changes. They are read-only by default, which makes them a good fit for code reviews and second opinions before you commit.
- **Cloud runs** execute in a Cursor VM on a pushed branch, push their work to a new `cursor/...` branch, and open a PR only when asked.
- **Follow-ups** continue the same agent conversation.
- **Long runs don't block.** A call waits up to `wait_seconds`, then returns an `agent_id` you pass to `cursor_wait`.

## Requirements

- Node.js 22.13 or newer.
- A Cursor API key from Cursor Dashboard > API Keys. Runs bill the Cursor account that owns the key.
- For cloud runs, Cursor's GitHub (or GitLab, Bitbucket, Azure DevOps) integration with access to the repository.

## Install in Claude Code

No environment variables are needed, and you don't even have to create an API key: you can sign in with your Cursor account in the browser.

1. Add the marketplace and install the plugin. In a Claude Code session:

   ```
   /plugin marketplace add zzzare/cursor-bridge
   /plugin install cursor-bridge@cursor-bridge
   ```

   From a terminal, the same is `claude plugin marketplace add zzzare/cursor-bridge` and then `claude plugin install cursor-bridge@cursor-bridge`. In the Claude desktop app, the plugin browser does it too.
2. When the plugin is enabled, Claude Code shows its settings. Leave the API key empty to sign in with the browser in step 3, or paste a key from Cursor Dashboard > API Keys (stored as a secret, never in a repository). Choose a default model and leave local writes off. Claude Code 2.1.269 and later can change these afterwards in `/config`.
3. Start a new session, because MCP servers connect when a session starts. If you left the key empty, say "sign in to Cursor": Claude calls `cursor_auth`, your browser opens Cursor's sign-in page, and once you confirm there, Claude calls it again to finish. The Cursor SDK creates a personal API key (valid for 90 days) and keeps it on your machine in `~/.cursor/sdk/auth.json`.
4. Ask Claude to "run cursor_models" to confirm everything works.
5. Use it in plain language, for example "have Cursor review my uncommitted changes with grok-4.6:effort=high", or invoke `/cursor-bridge:cursor`.

For cloud runs, also connect GitHub (or your git host) in Cursor so cloud agents can clone the repository.

A `CURSOR_API_KEY` environment variable also works, for example when Claude Code doesn't show plugin settings. The order is: plugin setting, then `CURSOR_API_KEY`, then the browser sign-in.

To share it with everyone working on a repository, install it with **Project scope**. That records the plugin in the repository's `.claude/settings.json`; teammates get the marketplace once they trust the folder and are shown the install command.

## Use with other MCP clients

Clone this repository, run `npm ci` in `plugins/cursor-bridge`, and register the server:

```json
{
  "mcpServers": {
    "cursor": {
      "command": "node",
      "args": ["/path/to/cursor-bridge/plugins/cursor-bridge/server/launch.mjs"],
      "env": { "CURSOR_API_KEY": "${CURSOR_API_KEY}", "CURSOR_BRIDGE_DEFAULT_MODEL": "composer-2.5" }
    }
  }
}
```

`${CURSOR_API_KEY}` works in clients that expand environment variables, such as Claude Code's `.mcp.json`. Other clients pass their own environment to the server, so a `CURSOR_API_KEY` variable set for your user also works.

## Tools

| Tool | What it does |
|---|---|
| `cursor_run_local` | Runs an agent on this machine against `cwd`. `access` is `read-only` (default), `no-tools`, or `full` (only when local writes are allowed). |
| `cursor_run_cloud` | Runs a cloud agent on `repo_url` at `ref`, both inferred from the local checkout when omitted. Never works on `ref` directly; `create_pr` opens a PR. |
| `cursor_followup` | Sends another message to an existing agent. |
| `cursor_wait` | Waits for a run and returns its reply. `wait_seconds: 0` only checks. |
| `cursor_status` | Lists an agent's recent runs, or the runs in progress and recently used agents. |
| `cursor_cancel` | Cancels a run. |
| `cursor_models` | Lists available models and their params, and confirms the key works. |
| `cursor_auth` | Shows how the server authenticates; `login` signs in with a Cursor account in the browser, `logout` removes that sign-in. |

Models are written as `id` or `id:param=value,...`, for example `grok-4.6:effort=high`.

## Configuration

| Environment variable | Plugin setting | Default | Meaning |
|---|---|---|---|
| `CURSOR_BRIDGE_API_KEY` | Cursor API key | none | The key the plugin passes in. Takes precedence over `CURSOR_API_KEY`. |
| `CURSOR_API_KEY` | none | none | Used when no plugin key is set. On Windows, a user environment variable saved after the client started is also picked up. |
| `CURSOR_BRIDGE_DEFAULT_MODEL` | Default model | `composer-2.5` | Model used when a call names none. |
| `CURSOR_BRIDGE_ALLOW_LOCAL_WRITES` | Allow local write access | `false` | Permits `access: "full"` on local runs. |
| `CURSOR_BRIDGE_MAX_RUN_MINUTES` | none | `60` | Cancels runs that take longer. `0` turns the limit off. |
| `CURSOR_BRIDGE_DATA_DIR` | set to the plugin data folder | `~/.cursor-bridge` | Where agent records used by follow-ups are kept. |

## Safety model

- Local agents are read-only unless local writes are allowed and the call asks for `full`. The restriction is applied again on every follow-up, because the SDK does not store it with the agent.
- Cloud agents always push to a new `cursor/...` branch and open a PR only when asked.
- Credentials embedded in a git remote URL are stripped before the URL is sent to Cursor.
- API keys are never logged or returned in tool output, including the key a browser sign-in creates, which stays in the Cursor SDK's credential file.
- Everything in a prompt, and every file an agent reads, goes to Cursor and the model provider.

## Notes and limits

- Only the agent's final message is returned, so prompts should ask for the complete answer there.
- Local runs live inside the server process. If the MCP client restarts, a local run in progress ends; `cursor_followup` on the same agent continues the conversation. Cloud runs keep going, and `cursor_wait` can pick them up from a new session.
- Loading project rules (`load_project_rules`, on by default) adds context to every model call of a local run.
- The SDK's sandbox is not available on Windows, so there the read-only tool list is what keeps local agents from writing.
- Cursor's usage API is not available on every account, so results report token counts rather than cost.
- Some MCP clients time out long tool calls. Keep `wait_seconds` below the client's limit and use `cursor_wait` for longer runs. Claude Code 2.1.212 and later moves MCP calls that take over 2 minutes to the background.

## Development

```bash
cd plugins/cursor-bridge
npm ci
npm test                                # unit tests with a fake SDK, no network
node scripts/smoke.mjs                  # real stdio MCP round trip, checks the API key
node scripts/smoke.mjs --run <folder>   # adds one small read-only run and a follow-up (uses Cursor usage)
node scripts/call.mjs --list            # tools with descriptions and parameters
node scripts/call.mjs cursor_run_local '{"prompt":"...","model":"composer-2.5"}'
node scripts/call.mjs --batch calls.json   # several calls in one server session; {{agent_id}} is filled from the previous result
```

To try the plugin without installing it: `claude --plugin-dir ./plugins/cursor-bridge`.

## License

MIT. See [LICENSE](LICENSE).
