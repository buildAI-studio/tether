# trail-mcp

An MCP server that lets coding agents — Claude Code, Cursor, Windsurf, or any
MCP-capable client — stream their work into **Trail** as traces.

The agent authenticates with a Trail API key pair and calls five tools; every
call becomes a span with Trail's `gen_ai.*` semantics, so runs appear across
the existing UI with **zero UI changes**:

| What the agent logs        | Where it shows in Trail                          |
| -------------------------- | ------------------------------------------------ |
| `trail_start_run` / `trail_finish_run` | Observations → Tracing (root agent span, full tree) + Analytics → Agents (runs) |
| `trail_log_step` (task / tool)         | Trace tree steps + Agents → Tools leaderboard    |
| `trail_log_llm_call`                   | LLM analytics (tokens, cost) + span I/O panel    |
| `trail_log_exception` / `status: error` | Observations → Exceptions                        |

## Install

Published as [`trailai-mcp`](https://www.npmjs.com/package/trailai-mcp) on
npm — no clone required. `npx` fetches and runs it on demand, so the config
below is the entire install.

Building from source (contributing to this repo, or running an unpublished
change) still works the old way:

```bash
cd mcp
npm install
npm run build
```

## Test

```bash
npm run build
npm test
```

## Configure your coding agent

Generate an API key pair in Trail (**Settings → API Keys**), then register the
server with your client.

**Claude Code**

```bash
claude mcp add trail \
  -e TRAIL_URL=https://api.trailai.dev/api/sdk/v1 \
  -e TRAIL_PUBLIC_KEY=pk-... \
  -e TRAIL_SECRET_KEY=sk-... \
  -e TRAIL_APP=claude-code \
  -- npx -y trailai-mcp
```

**Cursor / Windsurf** (`.cursor/mcp.json` or the equivalent):

```json
{
  "mcpServers": {
    "trail": {
      "command": "npx",
      "args": ["-y", "trailai-mcp"],
      "env": {
        "TRAIL_URL": "https://api.trailai.dev/api/sdk/v1",
        "TRAIL_PUBLIC_KEY": "pk-...",
        "TRAIL_SECRET_KEY": "sk-...",
        "TRAIL_APP": "cursor"
      }
    }
  }
}
```

Running from a local build instead (`npm run build` above), swap the
`command`/`args` for `node` and the absolute path to `mcp/dist/index.js`.

Environment variables:

| Var                | Required | Meaning                                     |
| ------------------ | -------- | ------------------------------------------- |
| `TRAIL_URL`        | no       | Trail SDK base URL. Defaults to `http://localhost:4319` (a local Tether instance); set to your Cloud URL (ends in `/api/sdk/v1`) to use Trail Cloud instead |
| `TRAIL_PUBLIC_KEY` | no       | From Settings → API Keys. Required for Trail Cloud, omit entirely for a local Tether instance (no auth) |
| `TRAIL_SECRET_KEY` | no       | From Settings → API Keys. Required for Trail Cloud, omit entirely for a local Tether instance (no auth) |
| `TRAIL_APP`        | no       | Service/agent name in the UI (`coding-agent`) |
| `TRAIL_ENV`        | no       | Environment tag (`default`)                 |
| `TRAIL_PROJECT_ROOT` | no   | Project root to discover the harness manifest from (skills, sub-agents, .mcp.json — default: process cwd) |
| `TRAIL_JUDGE_PROVIDER` | no   | LLM provider for the goal-attainment judge — only `openai` supported today |
| `TRAIL_JUDGE_API_KEY`  | no   | API key for the judge provider              |
| `TRAIL_JUDGE_MODEL`    | no   | Judge model id, default `gpt-4o-mini`       |
| `TRAIL_JUDGE_BASE_URL` | no   | OpenAI-compatible base URL, default `https://api.openai.com/v1` — also works with Azure OpenAI, OpenRouter, LiteLLM proxies, local vLLM/Ollama, etc. |

## Make the agent actually use it

Add an instruction to your agent's project rules (e.g. `CLAUDE.md` /
`.cursorrules`):

> At the start of every task, call `trail_start_run` with a short task name.
> Log each meaningful action with `trail_log_step` (kind `tool` for commands
> and file edits, `task` for planning/analysis), every model call with
> `trail_log_llm_call`, and failures with `trail_log_exception`. When the task
> completes, call `trail_finish_run` with a one-line summary.

## Composition capture (hooks)

`trailai-mcp hook <event>` is a subcommand Claude Code's own hooks can call.
It records two things into a local log for each session:

- **Skills and files actually used.** Skill invocations, slash-command
  expansions, and the file/tool attachments the harness reports in the
  transcript.
- **Content a hook silently injected into context.** Any text a hook returns
  as `additionalContext` (or equivalent) is captured from the transcript,
  whether or not the agent ever mentions it.

Why hooks rather than the MCP tools: the agent self-reporting what it loaded
is unreliable, and background or cloud sessions can't be watched live. Hooks
run inside Claude Code regardless of what the agent chooses to say, so the
record reflects what actually reached the context window.

### Register the hooks

Add this to your project's `.claude/settings.json` (or `~/.claude/settings.json`
for every project):

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          { "type": "command", "command": "npx -y trailai-mcp hook session-start" }
        ]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "*",
        "hooks": [
          { "type": "command", "command": "npx -y trailai-mcp hook pre-tool-use" }
        ]
      }
    ],
    "UserPromptExpansion": [
      {
        "hooks": [
          { "type": "command", "command": "npx -y trailai-mcp hook user-prompt-expansion" }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          { "type": "command", "command": "npx -y trailai-mcp hook stop" }
        ]
      }
    ]
  }
}
```

The event argument must be one of `session-start`, `pre-tool-use`,
`user-prompt-expansion`, or `stop`. Each hook reads its payload from stdin. Every event also
scans the session transcript for hook-injected context recorded since the last
call, so the order of events doesn't matter. Narrow the `PreToolUse` `matcher` (for example to `Read|Edit|Write|Skill`)
if you want to skip the process launch on tools you don't need to track.

### Where the output lands

Entries are appended to `trail-composition.jsonl` in the session's
`scratchpad_dir`. Older Claude Code versions don't send `scratchpad_dir`, so
the log falls back to the session's `cwd`. A small offset file
(`trail-composition.offset.json`) sits next to it so transcript scanning
resumes where it left off instead of re-reading the whole transcript on every
hook call.

### Local only in this version

Nothing is sent over the network yet. The composition log stays on the
machine that ran the session. Delivering it to Tether or Trail is a later
step, so for now the file is the whole output.

### Redaction and truncation

Content previews go through the same `sanitize()` pass used for diffs and
other structured payloads: known secret shapes (API keys, bearer tokens,
password- or token-shaped key/value pairs) are replaced with `[REDACTED]`, and
each preview is capped at 16KB with a `…[truncated, Nb]` marker showing the
original size. This is best-effort pattern matching, not a guarantee. The
recorded `sizeBytes` reflects the full untruncated content, so you can still
tell how large an injection was even when the preview is cut.

## What's new in 0.4.0

`trail_log_step` accepts an optional `diffs` array — `{ path, diff }` entries
holding unified-diff text for files the step changed. Purely additive: a
caller that passes no `diffs` behaves exactly as it did in 0.3.0, and no
upgrade step is required.

Diffs are redacted and truncated **before** they leave the process, the same
as every other structured payload. Large diffs are cut at whole-hunk
boundaries — hunk bytes are capped at 256KB per file and 1MB per step, with
each file's header always kept in full outside that cap so a changed file is
never silently dropped — so a truncated diff stays readable instead of ending
mid-hunk, and what was dropped is reported alongside it so the UI can say so.

Diffs are agent-reported. Tether records what the harness passes; it does not
read the filesystem to verify a diff against what actually changed on disk.

## Migrating from 0.2.x to 0.3.0

The `input`/`output`/`prompt`/`completion`/`stack`/`context` fields on
three tools change shape. Backward compatibility differs per tool — read
carefully, since not every old-shaped call fails loudly:

- `trail_log_step`: `input`/`output` now accept any JSON-serializable value
  instead of only a string — **not a breaking change for existing
  callers**, since a plain string is still a valid value. Pass the actual
  tool-call arguments/result object instead of a pre-truncated summary
  string to get the benefit.
- `trail_log_llm_call`: `completion` (a string) is now a single message
  object `{ role: "assistant", content: string, tool_calls?: unknown }` —
  an old string `completion` **fails validation loudly**, as expected.
  `prompt` (a string) is replaced by `messages` (an array of
  `{ role: "system" | "user" | "assistant" | "tool", content: string }`) —
  **a leftover `prompt` field is silently ignored, not an error**: the MCP
  SDK strips unrecognized fields rather than rejecting them, so an
  un-migrated caller still passing `prompt` will see its LLM-call events
  logged with no prompt data at all, not a validation error. Update every
  `trail_log_llm_call` call site to pass `messages` instead.
- `trail_log_exception` gains two new optional fields, `stack` (a string)
  and `context` (any JSON-serializable value) — **purely additive, not a
  breaking change**.

All structured values passed to these three tools are redacted (best-effort
pattern matching for common secret shapes — API keys, bearer tokens,
password/token-shaped key-value pairs — never a guarantee) and truncated
(each string value inside the structure is capped at 16KB) before being
sent, entirely on the client side; the server stores and renders whatever
it receives, unmodified. Already-recorded runs from 0.2.x keep rendering
exactly as they did before — nothing is migrated or rewritten.

## Notes

- Spans are sent immediately per tool call over HTTPS; the root agent span is
  emitted by `trail_finish_run` with the run's total duration.
- Auth failures surface as tool errors in the agent, so a bad key is visible
  instead of silently dropping traces.
- Run state is in-memory per MCP session; one session can hold multiple
  concurrent runs (each `trail_start_run` returns its own `run_id`).
- `status` on `trail_log_step`, `trail_log_llm_call`, and `trail_finish_run`
  takes `"ok"` or `"error"`; common synonyms (`success`, `failed`, `failure`,
  `pass`, `passed`, case-insensitive) are accepted too.
- Judging runs synchronously when `trail_finish_run` is called, only when
  both `TRAIL_JUDGE_PROVIDER`/`TRAIL_JUDGE_API_KEY` are set AND a `summary`
  was provided; it fails open (a judge problem never blocks or errors the
  run); it bills to whatever `TRAIL_JUDGE_API_KEY` is configured with, not
  Trail's own budget. The judge receives the goal, outcome summary, and the
  agent-declared status as untrusted, self-reported claims, weighed against
  the run's automatically-recorded step and error counts — sent as a
  separate, trusted message the judge is told to trust over the claims.
- `trail_start_run` captures a harness manifest and attaches it as a
  `gen_ai.agent.harness_manifest` JSON attribute on the root span
  `trail_finish_run` emits — a snapshot of what the harness had available
  at that run's start. It reads: skills from the project's own
  `.claude/skills/*/SKILL.md` and the developer's user-level
  `~/.claude/skills/*/SKILL.md` (each tagged with its `source`); sub-agents
  from `.claude/agents/*.md` (`name`, `description`, `tools`); and MCP
  server **names only** from the project's `.mcp.json` and
  `~/.claude.json`'s per-project config — never the server's `command`,
  `args`, or `env`, since MCP server configs routinely embed secrets there.
  Every source degrades silently on a missing directory/file or malformed
  content; this never blocks or errors the run. Each category is capped at
  50 entries with descriptions truncated to 300 characters, so the combined
  attribute stays well within the server's request size limit even with
  all four categories populated.
- With no env vars set at all, `trail_start_run`/`trail_finish_run`/etc. point at
  `http://localhost:4319` with no auth headers — the default for a local,
  self-hosted Tether instance (see `server/`). Set `TRAIL_URL` +
  `TRAIL_PUBLIC_KEY` + `TRAIL_SECRET_KEY` together to use Trail Cloud instead;
  existing Cloud configurations that already set all three continue to work
  exactly as before.
