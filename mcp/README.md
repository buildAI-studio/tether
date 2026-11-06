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

## Choose where it runs

Same install, same five tools — the only thing that changes is which
`TRAIL_URL`/keys you register it with (see
[Configure your coding agent](#configure-your-coding-agent) below). Pick
based on what you actually want out of it:

|                      | **Local** (default, no setup) | **Trail Cloud** |
| -------------------- | ------------------------------ | ---------------- |
| Setup                | None — works with zero env vars | Generate an API key pair first (Settings → API Keys) |
| Where the data goes  | Never leaves your machine (local SQLite, via [`trailai-tether`](../server)) | Trail's hosted backend |
| Who can see it       | Just you                       | Your whole team/org |
| What you get         | Tether's UI: Flight Recorder (run timeline + goal/verdict), Harness Anatomy (skills/sub-agents/MCP servers discovered), Coverage overlay (what a run actually used), Usage analytics (registered-but-never-used "dead weight") | Trail's existing UI: Observations → Tracing/Exceptions, Analytics → Agents, aggregated across everyone's runs — and feeds Trail's evaluation features (Business Evals, Drift Monitors) if your org uses them |
| Cost                 | Free, self-hosted              | Whatever your Trail plan covers |

Both modes emit the exact same spans, so switching later is just changing
env vars — nothing to re-instrument, and no data model difference between
them. Use local if you want to inspect your own work in detail with
nothing leaving your machine; use Trail Cloud once you want your team to
see what coding agents are doing across everyone's work, in one place.

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

**Other MCP-capable clients** (Codex, or anything else that speaks MCP):
this is a standard stdio MCP server, so the same `npx -y trailai-mcp`
command and env vars apply — register it the way that client documents
registering any stdio MCP server (the registration step differs per
client; the server and its tools don't).

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

> At the start of every task, call `trail_start_run` with a short task name,
> before doing anything else. Call `trail_log_step` after EVERY tool call —
> every file edit, shell command, search, read — as it happens, not a
> summary afterward (kind `tool` for commands/edits/searches, `task` for
> planning/analysis); do not decide a step is too minor to log. Log every
> model call with `trail_log_llm_call`, and failures with
> `trail_log_exception` immediately, before attempting a fix. When the task
> is fully done, call `trail_finish_run` once with a one-line summary.
> Err toward logging too much — under-logging defeats the point of this.

Leaving "log meaningful actions" vague (an earlier version of this
instruction) causes exactly the failure you'd expect: the agent decides most
of what it does isn't worth logging, and the resulting trace is a near-empty
root span instead of the actual work. Make the instruction mechanical, not a
judgment call.

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
