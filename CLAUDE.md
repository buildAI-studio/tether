# Tether

Agent harness observability, self-hosted and open-source. Lives on GitHub at
`buildAI-studio/tether` (moved from `tmam-dev/tether` — old remote URLs still
push/redirect, but `gh pr create` and similar tooling need the local `origin`
remote repointed to `buildAI-studio/tether` first, or they fail with a
confusing GraphQL error). Sibling to [Trail](https://trailai.dev) (private
repo `tmam-dev/trail`, MENA enterprise AI observability SaaS) — same team,
same OpenTelemetry `gen_ai.*` instrumentation, but narrow-wedge scoped to
agent-harness observability only (no guardrails/evals/vault/billing, which
stay proprietary in Trail).

Several files still point at the old `tmam-dev/tether` location
(`server/package.json`'s `homepage`/`bugs`/`repository`,
`server/src/registry.ts`'s `DEFAULT_REGISTRY_URL`, and a couple of
`docs/superpowers/plans/` snapshots) — left alone for now since fixing them
touches published npm metadata and a live CDN URL, not just documentation.

Two packages:
- `mcp/` — published to npm as `trailai-mcp`. MCP server coding agents
  (Claude Code/Cursor/Windsurf) install to stream traces. Defaults to local
  mode (`http://127.0.0.1:4319`, no keys) when no `TRAIL_URL`/keys are set.
  stdio-only, no hosted/remote transport yet.
- `server/` — published to npm as `trailai-tether`, run via
  `npx trailai-tether`. Plain `node:http`, embedded `better-sqlite3`
  (pinned `^12.11.1` — 13.x segfaults), zero-build. Serves the OTLP
  ingestion endpoint + the UI.

## Status

All four originally-planned UI surfaces are shipped and unified into one
persistent shell (left rail of runs, live-polled every 5s, + a main panel
that swaps between Detail/Harness/Analytics via a small vanilla-JS client
router — no bundler/framework):
- Flight Recorder (run detail/timeline, cost/tokens, judge verdict)
- Harness anatomy (skills/sub-agents/MCP servers discovered from the
  harness manifest)
- Coverage overlay (which manifest entries a run actually touched)
- Usage analytics (flags registered-but-never-used "dead weight" across
  all runs)

On top of that shell, the plugin view system now ships too: a third-party
plugin (a git repo with a `tether-plugin.json`, installed via
`npx trailai-tether plugin add|dev|remove`) can replace any one of those
three slots with its own iframe view, fed by the new read-only
`/api/v1/runs/:traceId`, `/api/v1/harness/:traceId`, and `/api/v1/analytics`
JSON routes — see `server/README.md`'s "Plugins" section.

`README.md`'s "Status" section predates this and undersells it (still
describes a placeholder-page server) — trust this file and the specs/plans
below over that paragraph until someone updates it.

Design history for all of the above lives in `docs/superpowers/specs/` and
`docs/superpowers/plans/` — read those before touching UI or manifest code,
they carry the "why" behind non-obvious decisions.

## Known gaps (verified against source 2026-08-25, not scheduled)

- `~/.claude/agents` (user-level sub-agent) discovery isn't implemented in
  `mcp/src/manifest.ts` — `discoverSubAgents(rootDir)` only reads
  project-level `.claude/agents`, unlike `discoverSkills`/`discoverUserSkills`
  which cover both. No `discoverUserSubAgents` exists.
- MCP servers in the harness manifest are name-only by design —
  `McpServerEntry = { name }`. `discoverMcpServers` deliberately excludes
  command/args/env ("those routinely hold secrets" per the source comment).
  No tool-list/tool-count field.
- No sub-agent composition/handoff graph — `SubAgentEntry` is a flat
  `{name, description, tools}`, no inter-agent relationship data.

## Testing

`node --test test/*.js` in both `mcp/` and `server/` (see each
`package.json`'s `test` script). Both suites pass as of the commit above.

## A real build-config gotcha

`server/tsconfig.json` needs `"moduleDetection": "legacy"` — without it,
`tsc` (under `module: "Node16"` + this package's `"type":"module"`) appends
a trailing `export {};` to any file with zero value exports (even one with
only `import type`/inline `import(...).Type` type-queries), which breaks
loading that file as a classic (non-`type="module"`) browser `<script>`.
Fix needs BOTH the tsconfig flag AND the browser-loaded file having zero
top-level `import`/`export` statements of its own. If a second
browser-loaded TS file gets added (currently only `server/src/static/app.ts`),
it needs the same treatment.
