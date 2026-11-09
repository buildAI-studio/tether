# Composition UI Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make composition data (already shipped: `server/src/composition.ts`'s `getCompositionView`, delivered via `mcp/`'s hook mechanism) actually visible in Tether's UI — including, and especially, for a crashed/background session that never produced a completed run, which is the entire reason this feature exists.

**Architecture:** Per the design spec's §6 (resolved after investigating the real code, not guessed): no new top-level tab, no new route. The rail merges `listRuns` with a new `listCompositionOnlySessions` so a rootless session becomes *discoverable*. The existing Detail route/URL (`/runs/:traceId`, `/fragments/detail/:traceId`) gets a fallback: a run renders exactly as today; no run but real composition data renders a new, much simpler composition-only fragment; truly nothing still 404s exactly as before. The client (`app.ts`) keeps its existing navigation path and gains a sibling mount function for the composition-only content island.

**Tech Stack:** TypeScript, `server/` package only (no `mcp/` changes in this plan), `better-sqlite3`, `node:test` for server-side logic, manual browser verification for the client-side pieces (this project has no automated test harness for `app.ts`'s browser JS — per this repo's own convention, UI changes get verified by actually running the server and clicking through in a browser, not just unit tests).

**Spec:** `docs/superpowers/specs/2026-11-08-context-composition-visibility-design.md` — this plan implements §6 in full. Everything else in the spec (Trail-side work, §5's reachability options) remains out of scope.

## Global Constraints

- **No DB schema change.** Reuse the existing `spans` table exactly as-is; `listCompositionOnlySessions` and the detail fallback both read the same `raw` JSON blob column everything else already reads.
- **Purely additive — a normal run's existing rendering must not change.** The refactor that lets the Detail route fall back to composition data must produce byte-identical output to today for every code path where a run actually exists. A crashed *self-reported* run (real step data, no root span, no attachment data — a different, not-yet-solved problem) must still 404 exactly as it does today; this plan does not change that case's behavior.
- **A composition-only `traceId` can never appear in `listRuns`'s results, and the merged rail must never show the same `traceId` twice.** Composition spans always carry a non-null synthetic `parentSpanId` (already guaranteed by the prior plan), so this holds by construction — but the merge logic itself must not introduce duplication.
- Follow established conventions: tab indentation, defensive attribute/value reads (this is unauthenticated ingest — a malformed value degrades, it never throws), `.js`-suffixed relative imports, JSDoc only where the WHY isn't obvious.
- No automated test exists for `server/src/static/app.ts` (browser JS). Its task's "testing" step is manual browser verification, not a unit test — call this out explicitly in that task rather than skipping verification.

## Review Focus

- A composition-only session leaking into `listRuns`, or the merged rail double-counting a `traceId` (shown once as a run row and once as a composition row) — the single highest-stakes regression, directly against this plan's own stated guarantee.
- The refactored Detail-route fallback changing behavior for an existing normal run (wrong status code, missing coverage data, different JSON shape) — this plan must not touch what already works.
- A crashed self-reported run (spans exist, no root, no attachment-shaped data) silently starting to render something instead of 404ing — would be a scope violation, not just a bug.
- Sorting the merged rail by two different summary types' timestamp fields (`RunSummary.startedAt` vs `CompositionSessionSummary.lastActivityAt`) when one is a malformed/empty string (both already degrade to `""` elsewhere in this codebase) — must not crash the sort or produce a nonsensical order that hides real entries.
- The composition-only detail page's client-side rendering choking on an entry with an empty `sessionId`, no `contentPreview`, or a `contentPreview` near the server's 16KB sanitize cap.

---

## Task 1: List composition-only sessions

**Files:**
- Modify: `server/src/composition.ts`
- Test: `server/test/composition.test.js` (extend)

**Interfaces:**
- Consumes: `getCompositionView` (same file, already shipped); `toNs`, `toIsoOrEmpty` (already exported from `runs.js`, already imported in this file).
- Produces:
  ```ts
  export interface CompositionSessionSummary {
    traceId: string;
    sessionId: string;
    entryCount: number;
    lastActivityAt: string;
  }
  export function listCompositionOnlySessions(db: Database.Database, limit: number): CompositionSessionSummary[]
  ```

Query candidate `traceId`s with: `SELECT traceId, MAX(startTimeUnixNano) as lastNs FROM spans WHERE traceId NOT IN (SELECT traceId FROM spans WHERE parentSpanId IS NULL) GROUP BY traceId ORDER BY lastNs DESC LIMIT ?`. This excludes every `traceId` that has ever had a root span (a normal run, even if some of its own child spans also match "non-null parentSpanId" — the `NOT IN` is keyed on the whole `traceId`, not per-row). For each candidate row, call `getCompositionView(db, row.traceId)`; skip it (don't include in the result) if that returns `null` or `{ entries: [] }` — this is what correctly excludes a crashed *self-reported* run (real step data under `gen_ai.harness.source_type`, no root, but no `gen_ai.harness.attachment.*` data either) from this list, since `getCompositionView` only ever returns entries for attachment-shaped spans. For a candidate that does have composition entries, build a `CompositionSessionSummary`: `traceId` from the row; `sessionId` from the first entry's `sessionId` field (all entries under one `traceId` share the same session, by construction); `entryCount` as `view.entries.length`; `lastActivityAt` as `toIsoOrEmpty(toNs(row.lastNs) ?? 0n)` — degrade to `""` if `toNs` returns `null` for a malformed `lastNs`, matching this file's existing degrade-not-throw convention (see the `startNs`/`timestamp` handling already in `getCompositionView`).

- [ ] **Step 1: Write the failing tests**

```js
// Add to server/test/composition.test.js
import { listCompositionOnlySessions } from "../dist/composition.js";

describe("listCompositionOnlySessions", () => {
  test("lists a composition-only trace, not a run", () => {
    const db = openDatabase(":memory:");
    insertSpan(db, attachmentSpan("t1", "s1", "parent-placeholder", { "gen_ai.harness.attachment.session_id": "sess-abc" }));
    const sessions = listCompositionOnlySessions(db, 50);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].traceId, "t1");
    assert.equal(sessions[0].sessionId, "sess-abc");
    assert.equal(sessions[0].entryCount, 1);
  });

  test("excludes a trace that has a real run (root span)", () => {
    const db = openDatabase(":memory:");
    insertSpan(db, { traceId: "run1", spanId: "root", parentSpanId: null, name: "run",
      startTimeUnixNano: "1700000000000000000", endTimeUnixNano: "1700000000000000000",
      raw: JSON.stringify({ attributes: [], status: { code: 1 } }) });
    insertSpan(db, attachmentSpan("run1", "s1", "root")); // same traceId as the run, hypothetically
    const sessions = listCompositionOnlySessions(db, 50);
    assert.equal(sessions.length, 0);
  });

  test("excludes a trace with spans but no attachment data (a crashed self-reported run)", () => {
    const db = openDatabase(":memory:");
    insertSpan(db, { traceId: "t2", spanId: "s1", parentSpanId: "some-nonexistent-root",
      startTimeUnixNano: "1700000000000000000", endTimeUnixNano: "1700000000000000000", name: "step",
      raw: JSON.stringify({ attributes: [{ key: "gen_ai.harness.source_type", value: { stringValue: "skill" } }], status: { code: 1 } }) });
    const sessions = listCompositionOnlySessions(db, 50);
    assert.equal(sessions.length, 0);
  });

  test("orders by most recent activity, descending", () => {
    const db = openDatabase(":memory:");
    insertSpan(db, { ...attachmentSpan("old", "s1", "p1"), startTimeUnixNano: "1600000000000000000" });
    insertSpan(db, { ...attachmentSpan("new", "s1", "p1"), startTimeUnixNano: "1700000000000000000" });
    const sessions = listCompositionOnlySessions(db, 50);
    assert.deepEqual(sessions.map((s) => s.traceId), ["new", "old"]);
  });
});
```

(`attachmentSpan` is this test file's existing helper — reuse it, extending its `overrides` parameter if needed for the `session_id` override in the first test.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npm run build && node --test test/composition.test.js`
Expected: FAIL (`listCompositionOnlySessions` not found)

- [ ] **Step 3: Implement `listCompositionOnlySessions` in `server/src/composition.ts`**

- [ ] **Step 4: Run tests to verify they pass**

Run: same as Step 2
Expected: PASS

- [ ] **Step 5: Run the full server suite**

Run: `cd server && npm test`
Expected: all suites pass

- [ ] **Step 6: Commit**

```bash
git add server/src/composition.ts server/test/composition.test.js
git commit -m "feat(server): list composition-only sessions for the rail"
```

---

## Task 2: Merge composition-only sessions into the rail

**Files:**
- Modify: `server/src/templates/rail.ts`
- Modify: `server/src/server.ts` (the `buildRail` function only)
- Modify: `server/src/templates/shell.ts` (add CSS for the new row style, alongside the existing rail-row rules)
- Test: `server/test/rail.test.js` if one exists (check first); otherwise add `server/test/rail.test.js`

**Interfaces:**
- Consumes: `RunSummary` (from `runs.js`, already imported in `rail.ts`); `CompositionSessionSummary` (Task 1, from `composition.js`); `listRuns` (already imported in `server.ts`); `listCompositionOnlySessions` (Task 1).
- Produces:
  ```ts
  export type RailEntry =
    | { kind: "run"; run: RunSummary }
    | { kind: "composition"; session: CompositionSessionSummary };
  export function renderRailBody(entries: RailEntry[], activeTraceId: string | undefined, nowMs: number): string
  ```
  This is a **breaking signature change** to `renderRailBody` (was `(runs: RunSummary[], ...)`) — deliberate, not an oversight; update every call site.

In `rail.ts`: rename the existing `railRow(run, ...)` function's role to handle only the `{kind:"run"}` case (keep its body as-is), and add a sibling `compositionRow(session: CompositionSessionSummary, activeTraceId, nowMs): string` rendering: a badge reading "no run" in place of the verdict dot (reuse `VERDICT_COLOR.unjudged`'s muted gray, or a similar neutral tone — your call on the exact shade, just visually distinct from the existing verdict-colored dots so it doesn't look like a 5th verdict state), a label `Session ${session.sessionId.slice(0, 8)}` falling back to `"Unknown session"` if `sessionId` is empty, and the same `rail-time` relative-time span using `session.lastActivityAt`. Link `href` is `/runs/${escapeHtml(session.traceId)}` — the same URL pattern as a run row, since Task 3 makes that route handle this case. `renderRailBody(entries, activeTraceId, nowMs)` dispatches on `entry.kind` per row and joins exactly as today; the empty-list message stays `"No runs yet."` unless you think the wording should broaden now that the rail can show composition-only sessions too (your call, state it in your report either way).

In `server.ts`, change `buildRail(db, active)` to:
```ts
function buildRail(db: Database.Database, active: string | undefined): string {
  const runEntries: RailEntry[] = listRuns(db, 50).map((run) => ({ kind: "run", run }));
  const compositionEntries: RailEntry[] = listCompositionOnlySessions(db, 50).map((session) => ({ kind: "composition", session }));
  const merged = [...runEntries, ...compositionEntries]
    .sort((a, b) => {
      const aTime = a.kind === "run" ? a.run.startedAt : a.session.lastActivityAt;
      const bTime = b.kind === "run" ? b.run.startedAt : b.session.lastActivityAt;
      return bTime.localeCompare(aTime);
    })
    .slice(0, 50);
  return renderRailBody(merged, active, Date.now());
}
```
(ISO 8601 strings sort correctly with plain string comparison; an empty string from a degraded timestamp sorts before any real date in `localeCompare`'s ascending sense, so it lands at the end of this descending sort — acceptable degradation, not a crash.) Import `RailEntry` and `listCompositionOnlySessions` at the top of `server.ts` alongside the existing imports from `rail.js`/`composition.js`.

In `shell.ts`, add CSS rules for `.rail-row-composition` / a `.rail-badge-composition` class (or whatever class names you used above) near the existing `.rail-row`/`.rail-dot` rules — small, visually distinct, consistent with the shell's existing muted/neutral tones (e.g. the same gray as `VERDICT_COLOR.unjudged`).

- [ ] **Step 1: Write the failing tests**

If `server/test/rail.test.js` doesn't exist yet, create it:

```js
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { renderRailBody } from "../dist/templates/rail.js";

describe("renderRailBody", () => {
  test("renders a run entry with its existing markup", () => {
    const html = renderRailBody([{ kind: "run", run: { traceId: "t1", goal: "Fix bug", verdict: "met", dur: "5s", startedAt: "2026-11-09T00:00:00.000Z" } }], undefined, Date.now());
    assert.match(html, /href="\/runs\/t1"/);
    assert.match(html, /Fix bug/);
  });

  test("renders a composition-only entry distinctly, linking to the same /runs/:traceId pattern", () => {
    const html = renderRailBody([{ kind: "composition", session: { traceId: "t2", sessionId: "0f962b5d-1234", entryCount: 3, lastActivityAt: "2026-11-09T00:00:00.000Z" } }], undefined, Date.now());
    assert.match(html, /href="\/runs\/t2"/);
    assert.doesNotMatch(html, /rail-dot-goal.*VERDICT/); // no verdict-dot markup for a composition row — adjust this assertion once you see the real markup; the intent is "doesn't look like a run row"
  });

  test("renders nothing special for an empty list", () => {
    assert.match(renderRailBody([], undefined, Date.now()), /No runs yet/);
  });
});
```

(The second test's exact assertion is a placeholder for "composition rows are visually distinguishable" — tighten it against your actual markup once written; the important thing is a real, specific assertion, not a vague one.)

Also add an HTTP-level test in `server/test/server.test.js` (wherever `/fragments/rail` is already tested — extend that block) proving the merge itself, not just `renderRailBody`'s rendering in isolation:

```js
test("GET /fragments/rail merges a run and a composition-only session without duplicating or crashing on a malformed timestamp", async () => {
  // Insert one normal run (root span) and one composition-only span whose
  // startTimeUnixNano is deliberately malformed (e.g. "not-a-number"), then
  // fetch /fragments/rail. Assert: status 200, the run's traceId appears
  // exactly once, the composition session's traceId appears exactly once,
  // and the response doesn't throw/500 despite the malformed timestamp.
  // Mirror this file's existing withServer()-style setup for the rail route.
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npm run build && node --test test/rail.test.js`
Expected: FAIL (`renderRailBody`'s old signature rejects the new `RailEntry[]` shape, or the composition markup doesn't exist yet)

- [ ] **Step 3: Implement the `RailEntry` union, `compositionRow`, updated `renderRailBody`, `buildRail`'s merge, and the new CSS**

- [ ] **Step 4: Run tests to verify they pass**

Run: same as Step 2
Expected: PASS

- [ ] **Step 5: Run the full server suite**

Run: `cd server && npm test`
Expected: all suites pass, including anywhere else `renderRailBody`/`buildRail` is exercised (search for other callers before declaring done — a signature change can break a test you didn't write today)

- [ ] **Step 6: Commit**

```bash
git add server/src/templates/rail.ts server/src/server.ts server/src/templates/shell.ts server/test/rail.test.js
git commit -m "feat(server): merge composition-only sessions into the rail"
```

---

## Task 3: Composition-only detail fragment

**Files:**
- Create: `server/src/templates/composition-detail.ts`
- Modify: `server/src/server.ts` (the three routes that call `getRun` and 404 on null: `/fragments/detail`, `/fragments/detail/:traceId`, and the initial full-page shell route for `/runs/:traceId`)
- Test: `server/test/composition.test.js` or `server/test/server.test.js` (template test in the former, route test in the latter — match whichever file already covers the route you're extending)

**Interfaces:**
- Consumes: `getRun`, `getCoverage` (existing); `getCompositionView` (Task 1's file, already shipped); `renderDetailFragment` (existing, unchanged); `renderNotFoundPanel` (existing, unchanged).
- Produces:
  ```ts
  export function renderCompositionFragment(traceId: string, view: CompositionView): string
  ```
  And, in `server.ts`, a shared helper (exact name your call, e.g. `renderDetailOrComposition`):
  ```ts
  function renderDetailOrComposition(db: Database.Database, traceId: string): { status: 200 | 404; body: string }
  ```

In `composition-detail.ts`, write a skeleton analogous to `flight-recorder.ts`'s but much simpler — no timeline/transport/steps sections, since there's no run to scrub through:
```html
<section class="mission" id="composition-mission"></section>
<section class="panel">
	<div class="panel-head"><h2>Attached</h2><span class="count" id="compositionCount"></span></div>
	<div class="insp" id="compositionEntries"></div>
</section>
```
`renderCompositionFragment(traceId, view)` embeds `{ traceId, ...view }` as a `<script type="application/json" id="composition-data">` island, JSON-stringified with the same `.replace(/</g, "\\u003c")` escaping `flight-recorder.ts`'s `renderDetailFragment` already uses (copy that exact convention, same reasoning: a `nameOrPath` or `contentPreview` containing a literal `</script>`-like substring must not end the tag early).

In `server.ts`, add the shared helper and use it in all three places that currently do `const run = getRun(db, traceId); if (!run) { 404 } else { renderDetailFragment(run, getCoverage(db, traceId)) }`:
```ts
function renderDetailOrComposition(db: Database.Database, traceId: string): { status: 200 | 404; body: string } {
	const run = getRun(db, traceId);
	if (run) return { status: 200, body: renderDetailFragment(run, getCoverage(db, traceId)) };
	const composition = getCompositionView(db, traceId);
	if (composition && composition.entries.length > 0) return { status: 200, body: renderCompositionFragment(traceId, composition) };
	return { status: 404, body: renderNotFoundPanel() };
}
```
Replace each of the three call sites' `getRun`/404/`renderDetailFragment` sequence with a call to this helper, writing `res.writeHead(result.status, {...}); res.end(result.body);` in place of what's there now. The `/fragments/detail` route (no `traceId` in the URL, resolves to the most recent run) only ever calls `getRun` on an id that came from `listRuns(db, 50)[0]`, which by definition is always a real run — leave that one call to `getRun` as the plan's own comment already explains, but still route its 404 case (shouldn't happen, but `getRun` could theoretically still return null) through the same helper for consistency, your call on whether that's worth it versus leaving that one route's existing shape alone since its `traceId` is never actually a composition-only one.

Do **not** change `/api/v1/runs/:traceId` (the plugin-facing API route) — that route is intentionally run-only; composition data already has its own API route (`/api/v1/composition/:traceId`, shipped in a prior plan) and mixing the two there isn't part of this plan.

- [ ] **Step 1: Write the failing tests**

```js
// composition.test.js (template-level) or server.test.js (route-level) — pick based on
// where this repo's existing detail-route tests live; mirror that file's style.
describe("renderCompositionFragment", () => {
	test("embeds traceId and entries as a JSON island", () => {
		const html = renderCompositionFragment("t1", { entries: [{ source: "pre_tool_use_hook", kind: "tool_file", nameOrPath: "/a.ts", sizeBytes: 5, sessionId: "s1", timestamp: "2026-11-09T00:00:00.000Z" }] });
		assert.match(html, /id="composition-data"/);
		const json = JSON.parse(html.match(/<script[^>]*id="composition-data"[^>]*>([^<]*)<\/script>/)[1]);
		assert.equal(json.traceId, "t1");
		assert.equal(json.entries[0].nameOrPath, "/a.ts");
	});
});
```

```js
// server.test.js — extend the existing detail-route test block
test("GET /fragments/detail/:traceId falls back to composition data when there's no run", async () => {
	// insert a composition-shaped span only (no root), then fetch /fragments/detail/<thatTraceId>,
	// assert 200 and that the body contains the composition JSON island — mirror this file's
	// existing withServer()-style test setup for the detail route.
});

test("GET /fragments/detail/:traceId still 404s for a traceId with no data at all", async () => {
	// unchanged existing behavior — confirm it still holds after the refactor.
});

test("GET /fragments/detail/:traceId still 404s for a crashed self-reported run (real step data, no root, no attachment data)", async () => {
	// Insert a span with no root (no parentSpanId: null row for this traceId) carrying
	// gen_ai.harness.source_type/source_name attributes (self-reported, not composition) --
	// getCompositionView returns {entries: []} for this, not null, so the fallback must still
	// 404 rather than rendering an empty composition panel. This is the plan's own scope
	// guarantee (Global Constraints): this plan does not change behavior for this case.
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npm run build && npm test`
Expected: FAIL (`renderCompositionFragment` not found; the fallback route test fails against the current 404-always behavior)

- [ ] **Step 3: Implement `renderCompositionFragment` and the shared `renderDetailOrComposition` helper, wired into all three routes**

- [ ] **Step 4: Run tests to verify they pass**

Run: same as Step 2
Expected: PASS

- [ ] **Step 5: Run the full server suite**

Run: `cd server && npm test`
Expected: all suites pass — pay particular attention to any existing test that exercises a normal run's detail route, confirming its output is byte-identical to before this refactor

- [ ] **Step 6: Commit**

```bash
git add server/src/templates/composition-detail.ts server/src/server.ts server/test/composition.test.js server/test/server.test.js
git commit -m "feat(server): fall back to a composition-only fragment when a traceId has no run"
```

---

## Task 4: Client-side mounting

**Files:**
- Modify: `server/src/static/app.ts`

**Interfaces:**
- Consumes: the `#composition-data` JSON island (Task 3) shaped `{ traceId: string; entries: CompositionEntry[] }`, where `CompositionEntry` is `{ source: string; kind: string; nameOrPath: string; sizeBytes: number; contentPreview?: string; sessionId: string; timestamp: string }` (mirror `server/src/composition.ts`'s `CompositionEntry` type — don't import it across the server/client boundary, just declare an equivalent local type in `app.ts`, matching this file's existing convention of not sharing types with server-only modules).
- Produces: `mountCompositionDataIfPresent(): string | null`, analogous to the existing `mountRunDataIfPresent`.

Add a `CompositionData` type and `mountCompositionDataIfPresent()`:
```ts
function mountCompositionDataIfPresent(): string | null {
	const dataEl = document.getElementById("composition-data");
	if (!dataEl) return null;
	const data = JSON.parse(dataEl.textContent || "null") as CompositionData | null;
	if (!data) return null;
	// render data.entries into #compositionEntries, a header line into #composition-mission
	document.title = `Tether — Composition (${data.entries.length} item${data.entries.length === 1 ? "" : "s"})`;
	return data.traceId;
}
```
Render each entry as a small card (reuse this file's existing escaping helper if one is accessible, or the pattern already used elsewhere in `app.ts` for untrusted string content — composition entries carry attacker/agent-controlled strings, same trust level as everything else already rendered here) showing: a `kind` badge, `nameOrPath` (or, for a `hook_injected_context` entry with no meaningful path, something sensible — your call), `source`, a formatted `timestamp`, and `contentPreview` if present (it can be up to ~16KB — don't render it unbounded/unstyled; a `<details>`/collapsible section or a scrollable fixed-height block is reasonable, your call on the exact treatment). Set `#composition-mission`'s text to something like `Session ${data.traceId} — no completed run, ${data.entries.length} item(s) attached`.

Wire it into `navigateTo`, in the branch that currently reads:
```ts
} else if (target.view === "detail") {
	resolvedTraceId = mountRunDataIfPresent() ?? target.traceId;
}
```
Change to:
```ts
} else if (target.view === "detail") {
	resolvedTraceId = mountRunDataIfPresent() ?? mountCompositionDataIfPresent() ?? target.traceId;
}
```
`mountCompositionDataIfPresent` doesn't need to set `currentUnmount` (no timers/listeners to clean up for this simple view) — the existing `if (currentUnmount) { currentUnmount(); currentUnmount = null; }` right before `$("content").innerHTML = html` already clears whatever the previous view set, and this view sets nothing new.

- [ ] **Step 1: Implement `mountCompositionDataIfPresent` and the `navigateTo` wiring**

There is no automated test for this file. Write the code carefully against Task 3's exact JSON shape.

- [ ] **Step 2: Build and manually verify in a browser**

Run `cd server && npm run build && npm start` (or whatever this package's existing dev-run convention is — check `server/package.json`'s scripts first), then:
- Navigate to a composition-only session's rail row (you'll need Task 5's seeded data for this, or seed one yourself: invoke `trailai-mcp hook pre-tool-use` with a crafted payload against this running server's `TRAIL_URL`, or POST a composition-shaped span to `/traces` directly).
- Confirm the row appears in the rail, visually distinct from a run row.
- Click it; confirm the composition-only fragment renders (entries list, no timeline/steps/coverage sections).
- Seed at least one entry with an empty `sessionId` and at least one with a `contentPreview` near the server's 16KB sanitize cap; confirm both render without breaking the layout (the empty-sessionId case shouldn't show a broken/blank label; the large-preview case shouldn't blow out the page or hang the browser).
- Confirm clicking back to a normal run still renders exactly as before (Coverage section intact, timeline intact).
- Confirm the browser's tab title updates correctly for both cases.

Report what you saw, including any rough edges, in your report file — this step's "evidence" is a description of what you observed, not a command+output pair, since there's no test harness for this layer.

- [ ] **Step 3: Commit**

```bash
git add server/src/static/app.ts
git commit -m "feat(app): mount composition-only detail fragments client-side"
```

---

## Task 5: End-to-end verification and docs

**Files:**
- Modify: `server/README.md` (if it documents the shell's surfaces — check first) or `CLAUDE.md` (if its "Status" section is the more natural place — your call, state which you chose and why)

**Interfaces:**
- Consumes: everything from Tasks 1–4, already shipped and committed.

- [ ] **Step 1: Full end-to-end browser pass**

Start the server fresh (`cd server && npm run build && npm start` or equivalent). Seed at least two scenarios: (a) a normal completed run (if one doesn't already exist in your local store, create one via the existing `mcp/` tool-call flow or reuse fixture data), and (b) a composition-only session with no run (invoke `trailai-mcp hook pre-tool-use` — or POST directly to `/traces` with a composition-shaped span, matching Task 1's test fixtures — against this running server). Using a real browser (not just curl): confirm the rail shows both, confirm each links to the right content, confirm a truly-unknown `traceId` typed into the URL bar still shows the not-found panel, confirm the Analytics and Harness tabs are entirely unaffected.

- [ ] **Step 2: Fix anything the browser pass surfaces**

If something's wrong, fix it in the relevant file from Tasks 1–4 and re-verify. Note what you found and fixed in your report.

- [ ] **Step 3: Update documentation**

Add a short mention of composition-only sessions now being visible in the rail/detail view to whichever doc (`server/README.md` or `CLAUDE.md`) you determined is the right place in Step 1 of this task. Keep it brief — a sentence or two, matching the existing tone.

- [ ] **Step 4: Commit**

```bash
git add <whichever files you changed>
git commit -m "docs: note composition-only sessions are now visible in the rail"
```
