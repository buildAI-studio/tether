# trailai-tether

Tether's local, self-hosted server — accepts the OTLP traces
[`trailai-mcp`](https://www.npmjs.com/package/trailai-mcp) sends and stores
them in embedded SQLite. No install beyond Node, no account, no API key.

## Run it

```bash
npx trailai-tether
```

Starts listening on `http://localhost:4319` (override with `TETHER_PORT`).
Data persists across restarts in an OS-appropriate app-data directory
(resolved via `env-paths`) — the exact path is printed on startup.

## Point your coding agent at it

`trailai-mcp` already defaults to `http://localhost:4319` with no
authentication when `TRAIL_URL`/`TRAIL_PUBLIC_KEY`/`TRAIL_SECRET_KEY` are
unset — so once this server is running, no extra configuration is needed:

```bash
claude mcp add trail -- npx -y trailai-mcp
```

## What's here today

- `POST /traces` — OTLP/JSON ingestion, matches the wire format
  `trailai-mcp` already sends. No auth (nothing to protect on one
  developer's own machine).
- A single-page shell: a left rail lists the 50 most recent runs (goal,
  verdict, relative time, live-updated every 5s) and stays on screen while
  the main panel swaps between three views, navigated client-side with no
  full page reload. The rail also surfaces composition-only sessions —
  any Claude Code session the `trailai-mcp` hooks captured skills/files/MCP
  server attachments for, marked with a "session" badge and the first 8
  characters of the session id instead of a goal. A composition session's
  traceId is derived from the Claude Code session id, while a run's traceId
  is an unrelated random value assigned by `trail_start_run`, so the two are
  never the same row by construction — but when the run's root span carries
  that session id (via `gen_ai.harness.session_id`, stamped whenever
  `CLAUDE_CODE_SESSION_ID` is set), the server treats the session as linked:
  its composition data is looked up and nested into that run's own Detail
  page (an "Attached" section alongside the Flight Recorder view), and the
  session is excluded from the rail entirely rather than appearing a second
  time as its own row. The "session" badge / "Not linked to a run" label
  now only ever shows up for a session that genuinely has no completed run
  — a crashed or still-running session, or one whose root span never got a
  session id. Clicking a genuinely orphaned composition-only row opens the
  same `/runs/:traceId` URL as a normal run, rendering a minimal "Attached"
  list of what it picked up rather than the full Flight Recorder view
  (which needs a completed run's root span):
  - **Detail** (`/runs/:traceId`, or `/` for the most recent run) — the
    Flight Recorder view: goal, verdict, a scrubbable step timeline with
    play/pause/speed controls, per-step expansion showing raw
    input/output, and a Coverage panel showing which of the run's
    harness manifest entries were actually used.
  - **Harness** (`/runs/:traceId/harness`) — the skills, sub-agents, and
    MCP servers that run's harness had available, reshaped from the
    manifest `mcp/` stamps on every run. Always follows whichever run is
    selected in the rail.
  - **Analytics** (`/analytics`) — aggregates coverage across every run
    in the store: which skills/sub-agents/MCP servers are used vs.
    registered but never touched ("dead weight").
  Every route above is a real server route — direct load, reload, and
  shared links all work without a client-side navigation step. Harness
  and Analytics are fully server-rendered (no-JS renders the real page).
  The Detail view builds its timeline in the browser from an embedded
  JSON island, as it always has (this predates the unified shell — see
  the Flight Recorder design spec) — with JS disabled you get the static
  skeleton, not the rendered replay. Client-side navigation (via
  `/app.js`) is progressive enhancement over the server routes, not a
  replacement for them.

## Plugins

A plugin is an alternative *view* for one of the three slots above — a
third-party Detail, Harness, or Analytics panel. It's a plain static web
page (any framework, any build tool), published as a git repo, installed
locally, and mounted in an iframe in place of the native panel, with the
run's `traceId` handed to it on the iframe URL's query string.

**Trust model, stated plainly:** the iframe is same-origin and its scripts
run, so an installed plugin has the host page's full privileges — it can
reach `window.parent` and read everything the `/api/v1/*` routes expose
(every prompt, model output, and verdict in your local store). The
`sandbox` attribute on the frame is a consistency convention, not a
security boundary. Install a plugin the way you'd `npm install` a package:
only if you trust the repo you're pointing at.

```bash
npx trailai-tether plugin add <git-url>   # clone + validate into <data-dir>/plugins/<slug>/
npx trailai-tether plugin dev <slug> [url]  # serve that slug's assets from a dev server (omit url to clear)
npx trailai-tether plugin remove <slug>   # delete the plugin and clear any dev override
```

`plugin dev` is the authoring loop: point a slug at e.g.
`http://localhost:5173` and Tether proxies `/plugins/<slug>/*` to your dev
server, so hot reload works while the plugin's `fetch` calls stay
same-origin.

### `tether-plugin.json` (plugin repo root)

| Field | Required | Meaning |
|---|---|---|
| `name` | yes | Display name, shown in the slot's picker. |
| `slug` | yes | Directory name and URL segment — one plain path segment, no separators. |
| `version` | yes | The plugin's own version string; Tether doesn't interpret it. |
| `author` | yes | Free-form author string. |
| `description` | yes | One-line description of the view. |
| `entry` | yes | Path (relative to the repo root) of the HTML file the iframe loads. |
| `replaces` | only for `kind: "panel"` (the default) | Exactly one of `detail`, `harness`, `analytics`. |
| `kind` | no | `"panel"` (default) or `"widget"`. A panel replaces one of the three slots above (see `replaces`); a widget is a smaller card on the Analytics dashboard (see below) and has no `replaces`. |
| `size` | only for `kind: "widget"` | `"small" \| "medium" \| "large"` — the widget's footprint in the Analytics dashboard's grid. |
| `tetherApiVersion` | yes | The plugin API version this targets — currently `1`. A mismatch leaves the plugin installed but skipped, with a warning on install and on every server startup. |
| `icon` | no | Path to an icon in the repo. |

### What a plugin can read

Three read-only JSON endpoints, same-origin, no auth, versioned by URL
prefix (a breaking change would ship as `/api/v2/*`):

- `GET /api/v1/runs/:traceId` — the run: goal, verdict, steps, cost/tokens,
  plus `coverage` (which harness manifest entries the run touched). As of
  `trailai-mcp` 0.3.0, each step's `io` pairs (`steps[].io[n][1]`) can be a
  string, object, array, number, boolean, or null — earlier versions
  always sent a string. A run logged by a pre-0.3.0 mcp client always has
  string `io` values; a run logged by 0.3.0+ can have any of those types.
  A plugin reading `io` should handle both.

  Each step also carries `id` (its own span id) and `parentId` (the span it
  reports as its parent). Address a step by `id` rather than by its position
  in `steps` — the array's order is not part of this contract. Every step
  currently parents to the run's root span, whose id appears as no step's
  `id`, so the structure is one level deep in practice; treat a `parentId`
  that matches no step as "child of the run root". Do not assume the parent
  graph is acyclic or that a `parentId` refers to the same run — spans arrive
  from unauthenticated ingest, so a tree built from these must break cycles
  and ignore unknown ids rather than trusting them.

  A step that changed files also carries `diffs`: an array of
  `{ path, diff, hunksShown, hunksTotal, bytesOmitted, partialHunk }`. The
  `diff` is unified-diff text, already secret-redacted and truncated at
  whole-hunk boundaries by the producer. When `hunksShown < hunksTotal` or
  `bytesOmitted > 0` the diff is incomplete, and `partialHunk` means the last
  hunk shown is itself cut mid-way — a plugin displaying a diff must surface
  that rather than presenting it as the whole change. The field is absent for
  steps that logged no diffs, including every run logged before
  `trailai-mcp` 0.4.0.
- `GET /api/v1/harness/:traceId` — that run's harness: skills, sub-agents,
  MCP servers.
- `GET /api/v1/composition/:traceId` — the composition entries recorded for a
  trace by the `trailai-mcp` hooks (skills, files, MCP servers, and
  hook-injected context). This route works even for a trace with no completed
  run: a crashed or still-running session never sends the root span that
  `/api/v1/runs/:traceId` needs, so this is the only view of its composition
  data. No UI consumes it yet.

  **This `traceId` is not a run's `traceId`.** A run's `traceId` is a random
  16-byte hex id assigned by `trail_start_run`. A composition trace's
  `traceId` is derived from the Claude Code session id instead (lowercased,
  dashes stripped, and only used as-is when that leaves exactly 32 hex
  characters — see `mcp/src/hooks/deliver.ts`'s `traceIdFromSessionId`) —
  a completely different id space from a run's `traceId`. Calling this route
  with a run's own `traceId` will essentially always 404; the only way to
  reach a session's composition data is with that session's id (session-id
  derived, not run-id derived). If a hook invocation's `session_id` is
  missing or malformed (so it can't be reduced to exactly 32 hex characters),
  its entries fall back to a random traceId instead, making them effectively
  unreachable via this API — only the local `trail-composition.jsonl` log on
  disk still has them. This is an accepted, documented limitation, not a bug.
- `GET /api/v1/analytics` — usage aggregated across every run in the store.

Unknown `traceId` gives a 404 with `{ "ok": false, "error": "..." }`.
Nothing here writes: a plugin cannot mutate the trace store.

### Analytics widgets

A plugin with `"kind": "widget"` in its manifest mounts as a small card in a grid on the
Analytics view instead of replacing the whole view — several widgets from different plugins can
be on the dashboard at once. Installed the same way as any plugin (`plugin add`); which widgets
are currently on the dashboard is picked via the "Add widget" control on the Analytics view itself,
and persisted server-side:

- `GET /api/v1/dashboard/analytics` — `{ "slugs": string[] }`, the ordered list of widget slugs
  currently on the dashboard (filtered to widgets that are still installed and version-compatible).
- `PUT /api/v1/dashboard/analytics` — body `{ "slugs": string[] }`, replaces the list wholesale.

A widget plugin reads data the same way a full-panel Analytics plugin does — `GET /api/v1/analytics`
— there is no separate widget-specific data API.

### Registry

Beyond "you already know the git URL," each of the pickers above (per-slot native/plugin picker,
Add-widget picker) also lists a "Browse marketplace" group: not-yet-installed entries from
`registry/plugins.json`, a small community-maintained index living in this repo. Picking one
installs it — same `plugin add` logic, triggered from the UI instead of the CLI — no need to know
its git URL up front.

A snapshot of the index ships bundled with this npm package for offline/first-run use, and is
opportunistically refreshed from a CDN URL in the background (at most once per 24h) whenever a
picker is rendered — never blocking a request, and falling back to whatever was last bundled or
cached if the fetch fails.

A registry entry is a minimal pointer, not a full manifest — `name`, `slug`, `repo`, `description`,
`kind` (`"panel" | "widget"`), and `slot` (panel entries only), mirroring `tether-plugin.json`'s
own `kind`/`replaces` fields. Adding, updating, or removing a listing is a pull request against
`registry/plugins.json` in this repo, reviewed the same way any other PR is — a listing being
present means "listed," not "reviewed" or "certified."

## Building from source

```bash
cd server
npm install
npm run build
npm test
```

`tsconfig.json`'s `"moduleDetection": "legacy"` is what lets
`src/static/app.ts` compile as a classic browser `<script>` (no
`export {}` wrapper forcing ES-module treatment) instead of an ES
module, despite the rest of this package being `"type": "module"` —
`src/static/app.ts` is served as-is via `GET /app.js` and loaded with a
plain `<script src="/app.js">`, not imported.

## License

Apache-2.0 — see [LICENSE](LICENSE).
