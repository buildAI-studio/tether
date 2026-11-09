# Link Run Sessions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop a session that completes a normal run from also showing up as a second, separate "composition-only" rail row for the same work — by actually linking the two, and surfacing the linked session's composition data inside the run's own Detail view instead of just hiding the duplicate.

**Architecture:** `mcp/`'s `trail_finish_run` tags a run's root span with the session id, read directly from the MCP server process's own `CLAUDE_CODE_SESSION_ID` environment variable (confirmed empirically, degrades to no-op when absent). On the server, that attribute becomes `RunView`/`RunSummary.sessionId`, used two ways: (1) `listCompositionOnlySessions` excludes any session that already has a linked run, removing the duplicate rail row at the source; (2) the Detail route looks up that session's composition data (via the same session-id-to-traceId derivation `mcp/`'s hook delivery already uses, duplicated server-side) and nests it into the run's own Detail page, in a new "Attached" section that follows the exact same pattern the existing "Coverage" section already uses.

**Tech Stack:** TypeScript, both `mcp/` and `server/` packages, `node:test`, and — for the client-side piece — `server/test/app.test.js`'s existing vm-based browser-JS test harness (confirmed to exist during the previous plan's final review; use it, don't skip it).

**Spec:** `docs/superpowers/specs/2026-11-08-context-composition-visibility-design.md` §7 — this plan implements it in full.

## Global Constraints

- **`CLAUDE_CODE_SESSION_ID` is an empirical finding about one installation's environment, not a documented contract.** Every read of it must degrade to "no link" (not throw, not log an error) when absent — a different harness, an older Claude Code version, or a future version that stops setting it must all behave exactly as if this plan didn't exist for that run.
- **This plan changes nothing about a genuinely orphaned composition-only session** (no linked run at all) — its rail row, its "not linked to a run" copy, its standalone detail fragment all stay exactly as shipped. Only a session that *does* have a linked run changes behavior.
- **`otlp.ts`'s `toAttributes` already drops `undefined` values** — passing `process.env.CLAUDE_CODE_SESSION_ID` straight through (no manual undefined-check) is correct and matches this file's existing convention.
- Follow established conventions: tab indentation, defensive attribute/value reads that degrade rather than throw on malformed unauthenticated-ingest data, `.js`-suffixed relative imports, JSDoc only where the WHY isn't obvious.
- **Reuse, don't duplicate, rendering logic.** `app.ts`'s `renderCompositionEntries` already exists and already does exactly what the new "Attached" section needs — call it, don't rewrite it.
- No DB schema change.

## Review Focus

- A malformed/empty `sessionId` on a run (shouldn't happen given the source, but this is unauthenticated ingest) must not crash `getCompositionViewForSessionId` or the exclusion check — must degrade to "no link" the same as a genuinely absent one.
- `listCompositionOnlySessions`'s new exclusion must not accidentally exclude a *different* genuinely-orphaned session that happens to share no relationship with any run — only exact `sessionId` matches against `listLinkedSessionIds`'s set should be excluded.
- The Detail route's new composition lookup for a found run must not change behavior when that run has no linked session (`sessionId: null`) — must render exactly as before this plan, same as the existing Coverage section does when there's nothing to show.
- The client-side "Attached" section must render correctly both when `runData.composition` is `null` (no linked session) and when it's an empty array (linked session, zero entries) — these are different states from "the field is absent" and from each other, and the existing `renderCompositionEntries([])` already handles the empty-array case correctly (confirm this, don't assume).
- `server/test/app.test.js`'s new tests must exercise the real rendering path (populate real DOM elements from a real `RunData` object), not a shallow mock — this project's prior plan found a real bug specifically because this file's test harness went unused; don't repeat that.

---

## Task 1: Tag a run's root span with its session id

**Files:**
- Modify: `mcp/src/tools.ts` (the `trail_finish_run` handler's span attributes)
- Modify: `mcp/README.md` (brief mention)
- Modify: `mcp/package.json` (version bump)
- Test: `mcp/test/tools.test.js` (extend)

**Interfaces:**
- Produces: a new `"gen_ai.harness.session_id"` attribute on the root span `trail_finish_run` sends, present only when `process.env.CLAUDE_CODE_SESSION_ID` is a non-empty string.

In `mcp/src/tools.ts`'s `trail_finish_run` handler (the `sendSpan(cfg, {...})` call around line 342), add `"gen_ai.harness.session_id": process.env.CLAUDE_CODE_SESSION_ID` to the `attributes` object, alongside the existing `gen_ai.agent.*` attributes. No other change to this handler. `otlp.ts`'s `toAttributes` (already shipped, unmodified) drops this key entirely when the env var is `undefined` or empty — confirm this is still true rather than assuming, by checking `toAttributes`'s current filter condition.

- [ ] **Step 1: Write the failing test**

```js
// Add to mcp/test/tools.test.js, near the existing trail_finish_run span-building tests
test("trail_finish_run includes gen_ai.harness.session_id when CLAUDE_CODE_SESSION_ID is set", async () => {
  const original = process.env.CLAUDE_CODE_SESSION_ID;
  process.env.CLAUDE_CODE_SESSION_ID = "0f962b5d-b5f1-42e0-a294-03819bc6eb8d";
  try {
    // Mirror this file's existing pattern for calling trail_start_run/trail_finish_run
    // and inspecting the span sendSpan was called with (check how existing tests in this
    // file capture the sent span — e.g. a stub TrailConfig/sendSpan, or by calling the
    // pure span-building function directly if one exists for the root span).
    // Assert the sent span's attributes include "gen_ai.harness.session_id": "0f962b5d-b5f1-42e0-a294-03819bc6eb8d".
  } finally {
    if (original === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
    else process.env.CLAUDE_CODE_SESSION_ID = original;
  }
});

test("trail_finish_run omits gen_ai.harness.session_id when CLAUDE_CODE_SESSION_ID is unset", async () => {
  const original = process.env.CLAUDE_CODE_SESSION_ID;
  delete process.env.CLAUDE_CODE_SESSION_ID;
  try {
    // Same setup as above; assert the sent span's attributes do NOT include
    // "gen_ai.harness.session_id" at all (not present as a key, not present as undefined).
  } finally {
    if (original !== undefined) process.env.CLAUDE_CODE_SESSION_ID = original;
  }
});
```

(Both tests restore the real env var afterward, in a `finally`, so they don't leak into other tests in the same process — mirror whatever env-var-isolation convention this test file already uses elsewhere, if any.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd mcp && npm run build && node --test test/tools.test.js`
Expected: FAIL (attribute not present / present when it shouldn't be)

- [ ] **Step 3: Add the attribute in `mcp/src/tools.ts`**

- [ ] **Step 4: Run tests to verify they pass**

Run: same as Step 2
Expected: PASS

- [ ] **Step 5: Run the full mcp suite**

Run: `cd mcp && npm test`
Expected: all suites pass

- [ ] **Step 6: Update `mcp/README.md`**

Add a brief mention (a sentence or two, near wherever `trail_finish_run` or the run's root span is already documented): a run's root span now carries the Claude Code session id when running under Claude Code, which Tether's server uses to link a run to its own composition data instead of showing it as a separate, unlinked entry.

- [ ] **Step 7: Bump `mcp/package.json`'s version from `0.6.0` to `0.7.0`**

A new, backward-compatible attribute — matches the established minor-bump-per-feature convention.

- [ ] **Step 8: Commit**

```bash
git add mcp/src/tools.ts mcp/test/tools.test.js mcp/README.md mcp/package.json
git commit -m "feat(mcp): tag a run's root span with its Claude Code session id"
```

---

## Task 2: Surface a run's session id and find linked sessions

**Files:**
- Modify: `server/src/runs.ts`
- Test: `server/test/runs.test.js` (extend)

**Interfaces:**
- Consumes: `asString`, `parseRaw` (already exported in this file).
- Produces:
  ```ts
  // RunView gains: sessionId: string | null
  // RunSummary gains: sessionId: string | null
  export function listLinkedSessionIds(db: Database.Database): Set<string>
  ```

In `getRun`, add `sessionId: asString(root.attrs["gen_ai.harness.session_id"]) ?? null` to the returned `RunView` object. In `listRuns`, add the same read (from each row's `parsed.attrs`) to each pushed `RunSummary`.

`listLinkedSessionIds(db)` queries every root span (`SELECT raw FROM spans WHERE parentSpanId IS NULL`), parses each via `parseRaw`, and collects `asString(attrs["gen_ai.harness.session_id"])` into a `Set<string>` wherever it's a non-empty string — skip (don't throw on) a row where `parseRaw` returns `null`. This is the set a later task uses to exclude already-linked sessions from the composition-only list.

- [ ] **Step 1: Write the failing tests**

```js
// Add to server/test/runs.test.js
describe("sessionId on RunView/RunSummary", () => {
  test("getRun surfaces the session id from the root span's attribute", () => {
    const db = openDatabase(":memory:");
    insertSpan(db, rootSpanWithAttrs("t1", { "gen_ai.harness.session_id": "sess-123" }));
    assert.equal(getRun(db, "t1").sessionId, "sess-123");
  });

  test("getRun returns null sessionId when the attribute is absent", () => {
    const db = openDatabase(":memory:");
    insertSpan(db, rootSpanWithAttrs("t2", {}));
    assert.equal(getRun(db, "t2").sessionId, null);
  });

  test("listRuns surfaces sessionId the same way", () => {
    const db = openDatabase(":memory:");
    insertSpan(db, rootSpanWithAttrs("t3", { "gen_ai.harness.session_id": "sess-456" }));
    assert.equal(listRuns(db, 50)[0].sessionId, "sess-456");
  });
});

describe("listLinkedSessionIds", () => {
  test("collects session ids from every root span", () => {
    const db = openDatabase(":memory:");
    insertSpan(db, rootSpanWithAttrs("t4", { "gen_ai.harness.session_id": "sess-a" }));
    insertSpan(db, rootSpanWithAttrs("t5", { "gen_ai.harness.session_id": "sess-b" }));
    const ids = listLinkedSessionIds(db);
    assert.ok(ids.has("sess-a") && ids.has("sess-b"));
    assert.equal(ids.size, 2);
  });

  test("skips root spans with no session id attribute", () => {
    const db = openDatabase(":memory:");
    insertSpan(db, rootSpanWithAttrs("t6", {}));
    assert.equal(listLinkedSessionIds(db).size, 0);
  });
});
```

(`rootSpanWithAttrs(traceId, extraAttrs)` — check whether this file's existing tests already have a helper like this for building a root-span `StoredSpan`; if so reuse it, extending its attribute set. If not, write a small local helper mirroring whatever pattern this file's existing root-span tests already use.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npm run build && node --test test/runs.test.js`
Expected: FAIL (`sessionId` undefined/missing, `listLinkedSessionIds` not found)

- [ ] **Step 3: Implement the `sessionId` reads and `listLinkedSessionIds` in `server/src/runs.ts`**

- [ ] **Step 4: Run tests to verify they pass**

Run: same as Step 2
Expected: PASS

- [ ] **Step 5: Run the full server suite**

Run: `cd server && npm test`
Expected: all suites pass

- [ ] **Step 6: Commit**

```bash
git add server/src/runs.ts server/test/runs.test.js
git commit -m "feat(server): surface a run's linked session id"
```

---

## Task 3: Server-side session-to-composition lookup, and exclude linked sessions

**Files:**
- Modify: `server/src/composition.ts`
- Test: `server/test/composition.test.js` (extend)

**Interfaces:**
- Consumes: `getCompositionView` (already shipped, this file); `listLinkedSessionIds` (Task 2, from `runs.js`).
- Produces:
  ```ts
  export function traceIdFromSessionId(sessionId: string): string | null
  export function getCompositionViewForSessionId(db: Database.Database, sessionId: string): CompositionView | null
  export function listCompositionOnlySessions(db: Database.Database, limit: number, linkedSessionIds: Set<string>): CompositionSessionSummary[]
  ```
  `listCompositionOnlySessions`'s signature change (adding `linkedSessionIds`) is **deliberate and breaking** — update its one existing call site (Task 5).

`traceIdFromSessionId(sessionId)` mirrors `mcp/src/hooks/deliver.ts`'s function of the same name — strip every non-hex character, lowercase, return the result if it's exactly 32 hex characters. Unlike the `mcp/` version, **do not** fall back to a random id here: this function is used to *look up* existing data, not to mint a new trace, so a malformed/empty `sessionId` should return `null` (nothing to look up) rather than a random, guaranteed-to-miss value.

`getCompositionViewForSessionId(db, sessionId)` calls `traceIdFromSessionId(sessionId)`; if that's `null`, return `null`; otherwise return `getCompositionView(db, thatTraceId)` unchanged.

In `listCompositionOnlySessions`, after building each candidate's `CompositionSessionSummary` (exactly as today), skip it (don't include it in the result) if `linkedSessionIds.has(summary.sessionId)`.

- [ ] **Step 1: Write the failing tests**

```js
// Add to server/test/composition.test.js
describe("traceIdFromSessionId (server-side)", () => {
  test("derives the same 32-hex traceId a UUID session id would produce", () => {
    assert.equal(traceIdFromSessionId("0f962b5d-b5f1-42e0-a294-03819bc6eb8d"), "0f962b5db5f142e0a29403819bc6eb8d");
  });
  test("returns null for an empty or malformed session id", () => {
    assert.equal(traceIdFromSessionId(""), null);
    assert.equal(traceIdFromSessionId("not-a-uuid"), null);
  });
});

describe("getCompositionViewForSessionId", () => {
  test("finds composition data by session id", () => {
    const db = openDatabase(":memory:");
    const traceId = "0f962b5db5f142e0a29403819bc6eb8d";
    insertSpan(db, attachmentSpan(traceId, "s1", "parent-placeholder", { "gen_ai.harness.attachment.session_id": "0f962b5d-b5f1-42e0-a294-03819bc6eb8d" }));
    const view = getCompositionViewForSessionId(db, "0f962b5d-b5f1-42e0-a294-03819bc6eb8d");
    assert.equal(view.entries.length, 1);
  });
  test("returns null for a malformed session id", () => {
    const db = openDatabase(":memory:");
    assert.equal(getCompositionViewForSessionId(db, "not-a-uuid"), null);
  });
});

describe("listCompositionOnlySessions excludes linked sessions", () => {
  test("a session id present in linkedSessionIds is excluded", () => {
    const db = openDatabase(":memory:");
    insertSpan(db, attachmentSpan("t1", "s1", "parent-placeholder", { "gen_ai.harness.attachment.session_id": "sess-linked" }));
    const linked = new Set(["sess-linked"]);
    assert.equal(listCompositionOnlySessions(db, 50, linked).length, 0);
  });
  test("a session id not in linkedSessionIds is still included", () => {
    const db = openDatabase(":memory:");
    insertSpan(db, attachmentSpan("t2", "s1", "parent-placeholder", { "gen_ai.harness.attachment.session_id": "sess-orphan" }));
    const linked = new Set(["sess-linked"]);
    assert.equal(listCompositionOnlySessions(db, 50, linked).length, 1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npm run build && node --test test/composition.test.js`
Expected: FAIL (new exports not found; `listCompositionOnlySessions` rejects/ignores the new parameter)

- [ ] **Step 3: Implement `traceIdFromSessionId`, `getCompositionViewForSessionId`, and the exclusion in `listCompositionOnlySessions`**

- [ ] **Step 4: Run tests to verify they pass**

Run: same as Step 2
Expected: PASS

- [ ] **Step 5: Run the full server suite**

Run: `cd server && npm test`
Expected: FAIL at this point is expected and fine — `server.ts`'s one call site to `listCompositionOnlySessions` hasn't been updated yet (Task 5). Confirm the *only* failures are from that call site's now-mismatched argument count, not anything in this task's own files.

- [ ] **Step 6: Commit**

```bash
git add server/src/composition.ts server/test/composition.test.js
git commit -m "feat(server): look up composition data by session id, exclude linked sessions"
```

---

## Task 4: "Attached" section in the run's Detail view

**Files:**
- Modify: `server/src/templates/flight-recorder.ts`
- Test: `server/test/composition.test.js` or wherever `renderDetailFragment` is already tested — mirror its existing location

**Interfaces:**
- Consumes: `CompositionView` (from `../composition.js`, already shipped).
- Produces:
  ```ts
  export function renderDetailFragment(run: RunView, coverage: CoverageView | null, composition: CompositionView | null): string
  ```
  **Breaking signature change** — Task 5's call site needs the new parameter; this task runs first specifically so that dependency is satisfied before Task 5 needs it.

Add a new section to `SKELETON`, immediately after the existing "Coverage" section, following that section's exact structure:
```html
<section class="panel">
	<div class="panel-head"><h2>Attached</h2></div>
	<div class="insp" id="compositionEntries"></div>
</section>
```
Use the element id `compositionEntries` — the **same** id `composition-detail.ts`'s standalone skeleton already uses for its entries container (safe: a page never renders both skeletons at once, and this lets `app.ts` reuse one rendering function for both, Task 6). Always include this section in the skeleton, the same way "Coverage" is always present regardless of whether there's anything to show — don't make the skeleton itself conditional.

`renderDetailFragment(run, coverage, composition)` embeds `{ ...run, coverage, composition }` into the same `#run-data` JSON island — one island, not two, same `.replace(/</g, "\\u003c")` escaping already used.

- [ ] **Step 1: Write the failing tests**

```js
describe("renderDetailFragment with composition data", () => {
  test("embeds the composition field in the run-data island", () => {
    const run = { traceId: "t1", goal: "g", agent: "a", verdict: "unjudged", score: null, narrative: null, totals: { dur: "1s", cost: null, tokens: null, steps: 0 }, steps: [], sessionId: "sess-1" };
    const composition = { entries: [{ source: "pre_tool_use_hook", kind: "tool_file", nameOrPath: "/a.ts", sizeBytes: 5, sessionId: "sess-1", timestamp: "2026-11-09T00:00:00.000Z" }] };
    const html = renderDetailFragment(run, null, composition);
    const json = JSON.parse(html.match(/<script[^>]*id="run-data"[^>]*>([^<]*)<\/script>/)[1]);
    assert.equal(json.composition.entries.length, 1);
  });

  test("includes the Attached section markup even when composition is null", () => {
    const run = { traceId: "t2", goal: "g", agent: "a", verdict: "unjudged", score: null, narrative: null, totals: { dur: "1s", cost: null, tokens: null, steps: 0 }, steps: [], sessionId: null };
    const html = renderDetailFragment(run, null, null);
    assert.match(html, /id="compositionEntries"/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npm run build && node --test test/composition.test.js` (or wherever you placed these)
Expected: FAIL (third parameter not accepted / skeleton lacks the new section)

- [ ] **Step 3: Add the "Attached" section and the third parameter to `renderDetailFragment`**

- [ ] **Step 4: Run tests to verify they pass**

Run: same as Step 2
Expected: PASS

- [ ] **Step 5: Run the full server suite**

Run: `cd server && npm test`
Expected: all suites pass

- [ ] **Step 6: Commit**

```bash
git add server/src/templates/flight-recorder.ts server/test/composition.test.js
git commit -m "feat(server): add an Attached section to the run Detail view"
```

---

## Task 5: Wire the exclusion and the nested lookup into server.ts

**Files:**
- Modify: `server/src/server.ts`
- Test: `server/test/server.test.js` (extend)

**Interfaces:**
- Consumes: `listLinkedSessionIds` (Task 2); `getCompositionViewForSessionId` (Task 3); `listCompositionOnlySessions`'s new signature (Task 3); `renderDetailFragment`'s new third parameter (Task 4, already landed).
- Produces: updated `buildRail` and `renderDetailOrComposition` (same names, same external shape — only their bodies change).

In `buildRail`, before building `compositionEntries`, add `const linkedSessionIds = listLinkedSessionIds(db);` and pass it as `listCompositionOnlySessions(db, 50, linkedSessionIds)`'s third argument.

In `renderDetailOrComposition`'s `if (run)` branch, change `renderDetailFragment(run, getCoverage(db, traceId))` to also compute and pass the run's own composition data: `renderDetailFragment(run, getCoverage(db, traceId), run.sessionId ? getCompositionViewForSessionId(db, run.sessionId) : null)`.

- [ ] **Step 1: Write the failing tests**

```js
// Add to server/test/server.test.js, in the existing /fragments/rail and detail-route blocks
test("GET /fragments/rail excludes a composition-only row once its session gets a linked run", async () => {
  // Insert a composition-only span under a session id, confirm it appears in /fragments/rail.
  // Then insert a run (root span) carrying the matching gen_ai.harness.session_id attribute,
  // re-fetch /fragments/rail, and assert the composition-only row is gone while the run's own
  // row is present. Mirror this file's existing withServer()-style rail test setup.
});

test("GET /runs/:traceId (or /fragments/detail/:traceId) includes the run's own composition data when linked", async () => {
  // Insert a run with gen_ai.harness.session_id set, and a composition span under the matching
  // derived traceId. Fetch the run's detail route and assert the response body's #run-data
  // JSON island includes a non-empty `composition` field with the expected entry.
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npm run build && node --test test/server.test.js`
Expected: FAIL (rail still shows the duplicate; detail response has no `composition` field)

- [ ] **Step 3: Wire `buildRail` and `renderDetailOrComposition` as described above**

- [ ] **Step 4: Run tests to verify they pass**

Run: same as Step 2
Expected: PASS

- [ ] **Step 5: Run the full server suite**

Run: `cd server && npm test`
Expected: all suites pass

- [ ] **Step 6: Commit**

```bash
git add server/src/server.ts server/test/server.test.js
git commit -m "feat(server): exclude linked composition sessions from the rail, nest them into the run's detail view"
```

---

## Task 6: Client-side rendering of a run's linked composition data

**Files:**
- Modify: `server/src/static/app.ts`
- Test: `server/test/app.test.js` (extend — this harness exists, use it)

**Interfaces:**
- Consumes: `renderCompositionEntries` (already exists in this file, exported-within-file — just call it).
- Produces: `RunData`'s type gains `composition: CompositionEntry[] | null`; `mountDetailPanel` gains a `renderComposition()` function mirroring `renderCoverage()`'s exact pattern.

Change `RunData`'s type declaration (currently `type RunData = import("../runs.js").RunView & { coverage: ... | null };`) to also include `composition: CompositionEntry[] | null` — note this is a flat array of entries (matching `CompositionView["entries"]`'s shape), not the `CompositionData` wrapper type (`{traceId, entries}`) that the standalone composition-only page uses, since `RunData` already has its own `traceId` from `RunView`.

Inside `mountDetailPanel`, add a `renderComposition()` function immediately after `renderCoverage()`, following its exact structure:
```ts
function renderComposition(): void {
	const entries = runData.composition, el = $("compositionEntries");
	el.innerHTML = renderCompositionEntries(entries ?? []);
}
```
(`renderCompositionEntries` already handles the empty-array case correctly — confirm this by reading it, don't re-implement the empty-state message.) Add `renderComposition();` to the existing call chain at the line that currently reads `renderMission(); renderStrip(); renderSteps(); renderInspector(); renderCoverage(); updatePlayhead(); initControls();` — insert it right after `renderCoverage();`.

- [ ] **Step 1: Write the failing tests**

Add to `server/test/app.test.js`, mirroring however this file's existing `mountDetailPanel`/Coverage-rendering tests are structured:

```js
test("mountDetailPanel renders linked composition entries into #compositionEntries", () => {
  const runData = { /* minimal RunView fields */ traceId: "t1", goal: "g", agent: "a", verdict: "unjudged", score: null, narrative: null, totals: { dur: "1s", cost: null, tokens: null, steps: 0 }, steps: [], coverage: null, composition: [{ source: "pre_tool_use_hook", kind: "tool_file", nameOrPath: "/a.ts", sizeBytes: 5, sessionId: "s1", timestamp: "2026-11-09T00:00:00.000Z" }] };
  // Drive this the same way this file's existing mountDetailPanel/Coverage tests do (likely via
  // the sandbox's mountDetailPanel or via navigateTo with a fetched fragment) — assert
  // elements.compositionEntries.innerHTML contains "/a.ts" (or whatever the real rendered marker is).
});

test("mountDetailPanel shows the empty state when composition is null", () => {
  // Same setup with composition: null — assert elements.compositionEntries.innerHTML matches
  // the "No composition data for this session." empty-state text renderCompositionEntries already produces.
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npm run build && node --test test/app.test.js`
Expected: FAIL (`#compositionEntries` not populated / `renderComposition` doesn't exist)

- [ ] **Step 3: Implement the `RunData` type change and `renderComposition()`**

- [ ] **Step 4: Run tests to verify they pass**

Run: same as Step 2
Expected: PASS

- [ ] **Step 5: Run the full server suite**

Run: `cd server && npm test`
Expected: all suites pass

- [ ] **Step 6: Manual browser verification**

Start the server against a scratch/throwaway data store (never the user's real local Tether data). Seed: a run with a linked session that has composition data, a run with no linked session (composition stays `null`), and confirm visually: the linked run's Detail page shows an "Attached" section with the entries; the unlinked run's Detail page shows the section with the empty-state message (or however you decide to handle a zero-entry "Attached" section visually — your call, state it in your report); the rail no longer shows a separate composition-only row for the linked session; a genuinely orphaned composition-only session (no run at all) still renders exactly as it did before this plan.

- [ ] **Step 7: Commit**

```bash
git add server/src/static/app.ts server/test/app.test.js
git commit -m "feat(app): render a run's linked composition data in its Detail view"
```

---

## Task 7: End-to-end verification and docs

**Files:**
- Modify: `server/README.md`

**Interfaces:**
- Consumes: everything from Tasks 1–6, already shipped and committed.

- [ ] **Step 1: Full end-to-end browser pass**

Start the server fresh against a scratch data store. Seed, in one session: a normal run whose session also produced composition data (confirm it appears once, in the rail, with its own composition nested in its Detail page); a genuinely orphaned composition-only session (confirm it still appears as its own row, still says "not linked to a run," still renders its standalone fragment); a plain run with no hooks/composition data at all (confirm its Detail page's "Attached" section shows the empty state, nothing broken). Confirm Analytics and Harness tabs are unaffected.

- [ ] **Step 2: Fix anything the browser pass surfaces**

If something's wrong, fix it in the relevant file from Tasks 1–6 and re-verify.

- [ ] **Step 3: Update `server/README.md`**

Update the paragraph §6's plan already added (about composition-only sessions in the rail) to mention that a session with a completed run now shows its composition data nested in that run's Detail page instead of as a separate row — the "not linked to a run" rail badge now only ever appears for a session that genuinely has none.

- [ ] **Step 4: Commit**

```bash
git add <whichever files you changed>
git commit -m "docs: note that a run's composition data is now linked, not duplicated"
```
