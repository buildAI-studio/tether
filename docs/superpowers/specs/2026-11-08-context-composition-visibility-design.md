# Context composition visibility — design

## Intent

Tether today can show what an agent *chose* to report. It cannot show what
got loaded into an agent's context without the agent ever reporting it —
and that second category is exactly what worries the user: skills that
auto-trigger, memory files, `CLAUDE.md`/project instructions, and
hook-injected content (e.g. a `SessionStart` hook dumping skill text into
context before the agent does anything) all happen *outside* any tool call,
so Tether's self-reporting model is structurally blind to them.

This worry is sharpest for Claude Code's own cloud/background sessions —
sessions running in a remote sandbox, unattended, that can modify the
user's software without anyone watching live. (Not to be confused with
"Trail Cloud," the separate paid SaaS sibling product that hosts the same
OTLP ingestion endpoint — a different thing from the background/cloud
*Claude Code sessions* this design is about, though §5 revisits Trail
Cloud as a plausible transport for exactly this case.) It also applies,
with lower stakes, to local interactive sessions.

This design treats Tether and Trail as one shared problem to solve
rather than a hard boundary: where the better fix touches Trail (its
shared ingestion pipe, or eventually its UI), that's in scope, not ruled
out by which repo currently owns the code.

Goal: give the user a complete, trustworthy record — per run — of
everything that got attached to the agent's context, however it got
there, plus everything the agent actively touched (files read/written),
without depending on the agent's cooperation to report it.

## Current state (verified against source, 2026-11-08)

- All of Tether's capture is self-reported. The agent is *instructed*
  (`mcp/README.md`: "call `trail_log_step` after EVERY tool call") to call
  `trail_start_run` / `trail_log_step` / `trail_finish_run` — nothing
  enforces this; an agent that skips a call simply produces no record of
  it.
- `trail_start_run` snapshots the harness manifest once
  (`mcp/src/manifest.ts`: `discoverSkills`, `discoverUserSkills`,
  `discoverSubAgents`, `discoverMcpServers`) — an inventory of what's
  *available* on disk at session start, not what gets used.
- "Usage" (`server/src/coverage.ts`) is a join between that manifest and
  each step's self-reported `source_type`/`source_name`
  (`gen_ai.harness.source_type`/`source_name` span attributes, set only
  when the agent passes `source_type`/`source_name` to `trail_log_step` —
  see `mcp/src/tools.ts`). No `source_type`/`source_name` means no
  attribution, silently.
- Structured tool-call args (rich-data-roadmap phase 1, shipped) mean a
  self-reported `Read`/`Edit`/`Write` step already carries its file path
  in a queryable JSON field. This covers "files the agent touched,"
  *if* it's self-reported — it does not cover silent attachment.
- Nothing in the current design touches Claude Code's hook system
  (`SessionStart`, `PreToolUse`, `PostToolUse`, etc.). Hooks are
  deterministic — Claude Code spawns them regardless of what the LLM
  decides — but Tether has no capture path through them today.
- Reachability: Tether defaults to `http://127.0.0.1:4319`, local-only,
  no auth. A background/cloud session runs in a sandbox that is not the
  user's machine, so it cannot reach that address at all. Any visibility
  into such a session needs either a publicly-reachable Tether instance
  or a delivery path that doesn't require live network access.

## Goals

1. Capture, per run, every skill that actually gets triggered or loaded —
   independent of whether the agent remembers to self-report it.
2. Capture, per run, everything silently attached to context outside any
   tool call: skill auto-triggers, memory files, `CLAUDE.md`/project
   instructions, hook-injected `additionalContext`.
3. Capture files actively read/written during the run, closing the gaps
   left by relying on self-report alone (same data Phase 1 already models
   — this just adds a second, non-agent-dependent path to it).
4. Make the capture mechanism's *ground truth* come from the harness
   (Claude Code's hook system), not the agent's willingness to narrate
   itself.
5. Produce a complete per-run timeline that is reviewable with zero
   dependency on the sandbox having live network access — a background
   session must not lose this data just because it can't reach Tether
   while running.
6. Lay the mechanism out so live/streaming visibility falls out for free
   once a reachable endpoint exists, rather than needing a second
   mechanism later.

## Non-goals

- Blocking, filtering, or gating what gets attached. This is observation
  only, because that's what was asked for — not because of a repo
  boundary. (Enforcement is a plausible later feature; nothing here rules
  it out, it's just not this project.)
- Building a *new* hosted relay service from scratch. Trail Cloud already
  is a publicly-reachable hosted ingestion endpoint on the same OTLP pipe
  (confirmed: `trail/server/src/controllers/traces.c.ts` ingests the same
  proto-shaped spans Tether does) — so for the reachability problem, using
  it is the answer, not a new thing to build. See §5.
- Patching or forking Claude Code. This uses only hook and MCP extension
  points Claude Code already exposes.
- A push-based (WebSocket/SSE) live UI in this phase. The existing 5s-poll
  Flight Recorder shell is sufficient once composition data lands in the
  database; a push UI is a separate, later improvement.
- Parity for Cursor/Windsurf. The capture mechanism in §1 is built
  entirely on Claude Code's own hook contract, which those clients don't
  share. v1 is explicitly Claude-Code-only; other `trailai-mcp` clients
  keep today's self-report-only behavior unchanged, with no regression
  and no silent-attachment capture. (My call — the whole brainstorm that
  produced this design was Claude-Code-specific; revisit if that
  changes.)

## Anti-goals

- Shipping something that still only extends the self-report convention
  (e.g. "add more optional params to `trail_log_step`") and calling the
  silent-attachment problem solved. It isn't solved unless the capture
  path is independent of the agent choosing to call anything.
- Requiring the user to remember to opt in per session. Once configured
  (project- or user-level hook config), it must apply automatically to
  every run, local or background, the same way `trail_start_run` already
  does today for self-report.
- Adding latency to the agent's actual work loop. Hooks must be
  fire-and-forget: write locally and return immediately; never block a
  tool call on a network round-trip to Tether.

## Design

### 1. Hook-based silent-attachment capture (new)

**Verified against Claude Code's own hooks reference (not just inferred)**
— spiked 2026-11-09 by fetching the docs directly, since a live-capture
spike (run a scoped nested session and inspect its real stdin payloads)
was blocked by this project's own worktree-isolation sandboxing, which
refuses to spawn nested `claude` subprocesses it can't verify won't touch
git. Treat the facts below as doc-verified, not yet confirmed against a
live payload — still worth a quick empirical check in a normal (non-
worktree-isolated) environment before locking the format in the plan.

Ship a small hook script bundled with `trailai-mcp`, invoked by Claude
Code's own hook contract (JSON payload on stdin), registered in
`.claude/settings.json` (project- or user-level) for three events:

- **`SessionStart`** — captures injected `additionalContext` verbatim
  (this is the exact mechanism that fired in this project's own session
  that led to this design: a `SessionStart` hook injected a full skill's
  text before any agent action). Stdin carries `source`
  (`startup|resume|clear|compact|fork`), `model`, and the common fields
  below. This is the primary source for "silent" attachments — skill
  auto-triggers, memory files, `CLAUDE.md`, whatever the harness decided
  to inject.
- **`PreToolUse`** — captures tool name + input JSON *before* execution,
  deterministically, regardless of whether the agent later calls
  `trail_log_step` for the same call. `tool_name` is a literal
  (`"Bash"`, `"Read"`, `"Edit"`, `"Write"`, `"Agent"`, `mcp__<server>__
  <tool>`, …) and `tool_input` is the tool's own argument schema — for
  Read/Write/Edit, `tool_input.file_path` is already normalized to an
  absolute path before the hook runs, which is exactly the "files
  actively touched" data this design wants, with no self-report needed.
  A skill the agent auto-triggers (not typed as `/name`) fires this hook
  with the Skill tool as the match target — doc-confirmed as a valid
  matcher, not yet confirmed as the literal `tool_name` string (flag for
  the empirical check).
- **`UserPromptExpansion`** — not in the original four candidates, found
  during the spike. This is the event that actually fires for a *typed*
  `/skillname` slash-command invocation, which bypasses `PreToolUse`
  entirely. Without this event, v1 would silently miss every
  explicitly-invoked skill and only catch auto-triggered ones — added to
  the v1 hook list for that reason, not left as a "maybe later."
- `PostToolUse` / `PostToolUseFailure` / `PermissionRequest` /
  `PermissionDenied` exist and are documented, but nothing in the
  brainstormed goals needs them yet — left out of v1 deliberately rather
  than by omission.

**Second finding, bigger than the first, verified directly against this
project's own running session (no nested process needed — this session's
own transcript file was readable locally):** a hook cannot see what a
*different* hook injected via its own stdin fields — `SessionStart`'s
payload tells you `source`/`model`/`session_id`, never another hook's
`additionalContext`. That looked like it broke the core premise (the
motivating example was literally "a `SessionStart` hook injected a whole
skill's text, and nothing we register could see that"). It doesn't,
because of `transcript_path`: Claude Code logs **every** hook invocation,
from any source, as a `{"type":"attachment","attachment":{"type":
"hook_success",...}}` record in that session's transcript JSONL —
verified by reading this session's own transcript file directly and
finding the superpowers plugin's `SessionStart` hook's exact injected
text, verbatim, inside `attachment.stdout`, alongside `hookName`
(`"SessionStart:startup"`), `hookEvent`, `command`, `exitCode`,
`durationMs`. This is generic hook-execution logging, not something
`SessionStart` does specially — it is how we get visibility into hooks
we didn't write and can't otherwise observe.

This changes the mechanism from "three hooks that each report their own
narrow stdin fields" to: **register `SessionStart` + `PreToolUse` (+
`Stop`, as a final-flush safety net for a session that starts and ends
without ever calling a tool) purely as triggers**, and on each firing,
read `transcript_path`, scan forward from the last offset we've
processed for this session (tracked in a small sidecar file next to our
own log, keyed by `session_id`) for new `type:"attachment"` entries —
*any* `hookEvent`, *any* `hookName`, ours or a third party's — and
convert each into an `AttachmentEntry`. `tool_name`/`tool_input` for
"files actively touched" still comes from `PreToolUse`'s own documented
stdin directly (reliable, documented, no transcript dependency needed
for that half) — transcript parsing is scoped narrowly to the one thing
with no other access path: other hooks' injected content. `transcript_path`
is "written asynchronously, may lag the in-memory conversation" per the
docs, so this is near-real-time, not instantaneous — fine for the
after-the-fact case this design is built around, and it's the local log
that's authoritative regardless of timing.

Trade-off worth stating plainly: the hooks contract (`tool_name`,
`tool_input`, `source`, etc.) is Anthropic's documented, presumably
more stable surface; the transcript's internal JSONL shape
(`attachment.type`, `attachment.hookEvent`, …) is not a published,
versioned contract. Parse it defensively — a line that doesn't match the
expected shape is skipped, never thrown — so a format change in a future
Claude Code version degrades to "composition capture quietly stops
adding new entries" rather than breaking the agent's own tool-call loop.

**Hard constraint found during the spike, not obvious beforehand:**
`PreToolUse`'s JSON output can set `permissionDecision`
(`allow|deny|ask|defer`) and `PostToolUse`'s can rewrite what Claude
sees (`updatedToolOutput`). Our logger hook must never emit any JSON (or
any stdout at all, since plain stdout on some events is itself read as
additional context) — it logs as a pure side effect and exits 0 with
nothing on stdout. Getting this wrong doesn't just pollute data, it can
silently alter the agent's permission flow or its tool-call context.

The hook script never makes a blocking network call on the critical path.
It appends one JSONL record per event to a local, append-only log file,
tagged with the session id and timestamp, and returns immediately.
Separately, best-effort and non-blocking, it attempts to forward the
same event live if a reachable `TRAIL_URL` is configured — this is what
makes "live" fall out for free once reachability exists, with the local
log as the durable source of truth regardless.

### 2. Getting the local log to Tether

A background sandbox may never have network access to Tether while
running. Two delivery paths, not mutually exclusive:

- **Live, best-effort**: if `TRAIL_URL` is reachable, the hook POSTs each
  event as it happens (or a flush step at `trail_finish_run` uploads the
  accumulated log as a batch). This is the "stream" case, and it's just
  the existing OTLP pipe plus a new attribute namespace — no new
  transport.
- **Carried with the workspace, always available**: the local JSONL log
  lives inside the session's working directory, so it travels with
  whatever the background job already produces (a commit, a PR, a
  worktree). This guarantees the data exists and is reviewable after the
  fact even with zero network access during the run — the default this
  design leans on for background/cloud sessions specifically.

### 3. Data model: composition, distinct from coverage

Add a new **composition** record per run, additive alongside the existing
`coverage.ts` (which stays as-is — "did a known manifest entry get
self-reported as used" is still a useful, narrower question):

```
AttachmentEntry {
  source: "pre_tool_use_hook" | "user_prompt_expansion_hook"
        | "transcript_hook_attachment" | "self_reported"
  // "transcript_hook_attachment": recovered by scanning transcript_path
  // for a *different* hook's recorded invocation (§1) — this is the
  // lane that actually answers "what got silently attached." The other
  // three are each a hook reporting its own directly-observed event.
  kind: "skill" | "memory_file" | "claude_md" | "tool_file" | "mcp_server"
      | "hook_injected_context"  // transcript_hook_attachment entries
                                 // whose content doesn't cleanly map to
                                 // a manifest category — still surfaced,
                                 // not dropped, with hookName as context
  nameOrPath: string
  sizeBytes: number
  contentPreview?: string     // sanitize()-truncated/redacted, see §4;
                              // present when the source captured real
                              // content (hook payloads), absent when it
                              // only ever had a name/path (e.g. an MCP
                              // server entry)
  timestamp: string
}
```

Composition is the broader lens: it includes things with no manifest
entry at all (a memory file, a hook-injected blob) and things the agent
never self-reported. Coverage keeps answering "was this known thing used
according to the agent"; composition answers "what actually entered
context and when, regardless of who reported it."

`source: "self_reported"` entries are a read-time reshape of data Tether
already has — today's `gen_ai.harness.source_type`/`source_name` step
attributes and Phase 1's structured tool-call args — projected into the
`AttachmentEntry` shape, the same way `coverage.ts` already reshapes
existing step data rather than introducing a new write path. No new MCP
tool and no `trailai-mcp` schema change for this lane. (My call — a new
explicit self-report-an-attachment tool would duplicate data the agent
already reports through existing fields.)

UI: a new tab/section in the existing persistent shell (per the unified
shell design already shipped) showing this per-run timeline — most
likely its own panel rather than folded into Harness anatomy, since
composition is temporal/per-run while Harness anatomy is a static
inventory. Exact placement is left to the builder (§ Open Questions).

Composition listing must not require a root span. `server/src/runs.ts`'s
`getRun`/`listRuns` today only surface a run once `trail_finish_run` has
emitted its root span (`parentSpanId IS NULL`) — but a `SessionStart`
hook mints a run id before any agent action, and a background job can
end (timeout, crash, or an agent that never calls any `trail_*` tool at
all) without ever calling `trail_finish_run`. That's precisely the
unattended-sandbox case this design exists for, so losing the composition
record whenever a run doesn't cleanly finish would defeat the point.
Composition entries must be listable/viewable by their hook-known run id
directly, independent of whether a root span exists yet, with a
synthetic/partial run row standing in until (or in place of) a real one.
(My call — this follows directly from Goal 5; flagging it explicitly
because it means `runs.ts`/the rail UI need a small accommodation beyond
"add a new panel.")

### 4. Redaction and size limits

Hook payloads can be large and can contain file contents (a `SessionStart`
`additionalContext` blob can be arbitrarily big — again, exactly what
happened in this project's own session). Reuse the existing `sanitize()`
conventions from Phase 1 (16KB per-string-leaf truncation, secret-pattern
redaction) rather than inventing a second redaction mechanism for this new
input path.

### 5. Reachability / deployment

The reachability problem is specific to background/cloud sessions: a
sandbox can't reach a `localhost`-only Tether instance. Three options,
in increasing effort:

1. **After-the-fact, zero network dependency (default, always works)** —
   the local log ships with the workspace; reviewed via the local Tether
   UI once it's reachable again. No infrastructure needed, works even
   with Tether alone.
2. **Self-hosted public instance** — `trailai-tether` run on a reachable
   host (VPS, `ngrok`/`cloudflared` tunnel, etc.), `TRAIL_URL` pointed at
   it so the hook's best-effort POST reaches it live. Operationally
   fiddly (the user runs and exposes their own server).
3. **Trail Cloud as the transport** — the real answer for "I want this
   live for background sessions without babysitting a tunnel." Since
   Trail already ingests the same OTLP shape Tether does, pointing
   `TRAIL_URL`/keys at Trail Cloud gets live delivery with no new backend
   work — Trail is already a publicly-reachable ingestion endpoint by
   design. What Trail does *not* have today is anywhere to render the
   data: there is no harness-manifest/coverage concept at all in
   `trail/web-client` or `trail/server` yet (verified — zero hits for
   "harness"/"manifest"/"coverage"). Porting the harness-anatomy/coverage
   concept, and then this composition view, to Trail is a real option
   worth doing, but it's a separate, larger body of work from what this
   document scopes — flagged here as a deliberate option, not folded into
   this plan, so it isn't lost or quietly treated as off-limits.

## What's left to the builder

Resolved by the 2026-11-09 documentation spike (§1 has the detail):

- **Hook event list for v1**: `SessionStart` + `PreToolUse` +
  `UserPromptExpansion` — settled, with a reason for each inclusion and
  each omission, not a placeholder to revisit.
- **Run correlation**: no custom id-minting needed. `session_id` is a
  common field on every hook event (`SessionStart`, `PreToolUse`,
  `UserPromptExpansion` all carry it) — use it directly as the
  correlation key between hook-captured composition data and
  self-reported run data, rather than inventing a handoff scheme.
- **Local log location**: use the `scratchpad_dir` field Claude Code
  already provides in hook stdin (session-scoped scratch path, v2.1.257+)
  as the primary location; fall back to `cwd` on older versions where
  it's absent.

Still open, genuinely undecided:

- **Empirical confirmation**: the spike above is doc-verified, not
  live-captured (worktree-isolation blocked spawning a nested session to
  inspect real payloads — not a restriction that applies outside this
  background job's sandbox). Before locking the wire format in the plan,
  actually run a scoped hook logger once in a normal environment and
  diff its output against the documented shapes above, especially
  whether `tool_name` is literally `"Skill"` for an auto-triggered skill.
- **Ingestion shape**: confirm whether composition events reuse the
  existing OTLP span/event pipe with a new attribute namespace
  (`gen_ai.harness.attachment.*`) versus a dedicated endpoint — reusing
  OTLP keeps one pipe and is the likely answer, but verify against
  `otlp.ts`/`runs.ts` before committing.
- **UI placement**: new tab in the shell vs. augmenting Harness anatomy —
  lean toward a new tab (my call, stated here so it can be revisited), not
  agreed upon with the user beyond this document.
