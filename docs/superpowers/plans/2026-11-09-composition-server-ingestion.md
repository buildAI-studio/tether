# Composition Server Ingestion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Get the composition data the `trailai-mcp hook` subcommand already captures locally (shipped in the previous plan) into Tether's server and queryable via a read-only API — including for background/crashed sessions that never produced a normal run. No UI in this plan; that is explicitly deferred.

**Architecture:** Two independent halves that meet at one wire format. On the `mcp/` side, a new best-effort, timeout-bounded delivery path converts each locally-captured `AttachmentEntry` into an OTLP span (traceId derived deterministically from the session id, so all of one session's composition spans land under one trace) and POSTs it to `TRAIL_URL`, exactly like the existing self-report tool calls already do — but never blocking, never throwing, with the local JSONL log (already shipped) remaining the durable source of truth regardless of delivery success. On the `server/` side, a new `composition.ts` reads those spans straight out of the existing `spans` table by `traceId`, deliberately *not* going through `getRun`/`listRuns`'s root-span-gated query, so a session with no `trail_finish_run` (a crash, a background job that just ends) still has its composition data queryable. A new `/api/v1/composition/:traceId` route exposes it, mirroring the existing `/api/v1/harness/:traceId` convention exactly.

**Tech Stack:** TypeScript, two existing packages (`mcp/`, `server/`), `node:test`, `better-sqlite3`. No new dependencies, no DB migration (the `spans` table's `raw` JSON blob already holds whatever attributes are POSTed to it).

**Spec:** `docs/superpowers/specs/2026-11-08-context-composition-visibility-design.md` — this plan implements §2's "live, best-effort" delivery path and the server half of §3 (a `CompositionView`/API route distinct from `coverage.ts`). §3's UI panel and §5 (Trail/reachability deployment options) are explicitly out of scope — this plan stops at a queryable API, confirmed with the user.

## Global Constraints

- **The best-effort delivery attempt must never add more than ~2 seconds of latency to the hook's completion, regardless of `TRAIL_URL`'s reachability, and must never throw or write to stdout.** This extends the previous plan's exit-0/stdout guarantees to cover a real network call for the first time — get this wrong and a hook with an unreachable `TRAIL_URL` stalls every tool call in the session.
- **A composition span must never have `parentSpanId` unset/null.** `server/src/runs.ts`'s `listRuns` query is `WHERE parentSpanId IS NULL` — a composition span that satisfies that would silently appear as a bogus "run" in the existing rail/run list, which this plan must not cause (UI is explicitly deferred; nothing should change about what the existing UI shows).
- **`getCompositionView` must not depend on a root span existing for the trace.** This is the entire reason this plan exists — `getRun`/`listRuns` only ever surface a trace with a `parentSpanId IS NULL` root (which only `trail_finish_run` creates), so a crashed/background session's composition data would otherwise be invisible exactly when it matters most.
- No `server/src/db.ts` schema change. The `raw` column already holds the full span JSON; a new `gen_ai.harness.attachment.*` attribute namespace is readable from it with zero migration.
- Reuse existing exported helpers rather than reimplementing: `mcp/src/otlp.ts`'s `sendSpan`/`hexId`/`nowNanos`/`toAttributes`/`SpanInput`/`TrailConfig`; `server/src/runs.ts`'s `asString`/`toAttributeMap`/`toIsoOrEmpty` (already exported) and `parseRaw` (currently private — export it as part of this plan, see Task 1).
- No UI changes. No change to `server/src/templates/*`, `server/src/static/app.ts`, or `server/src/rail.ts`.
- ESM, `.js`-suffixed relative imports, tab indentation, matching each package's existing conventions.

## Review Focus

- A composition span accidentally shipping with `parentSpanId` unset, making it satisfy `listRuns`'s `WHERE parentSpanId IS NULL` and leak into the existing run rail as a bogus entry — the single highest-stakes regression this plan could introduce, and the previous plan's final review found exactly this class of mistake once already. Needs an explicit test asserting `listRuns` does not pick up a composition-only trace.
- `getCompositionView` called on a traceId whose only spans are from an incomplete run (no root, no `trail_finish_run`) must still return real entries, not null — the literal point of this plan. Needs a test with spans that have no `parentSpanId IS NULL` row among them at all.
- The best-effort delivery hanging past its timeout budget on an unreachable or slow `TRAIL_URL`, delaying the hook itself — needs a test against a genuinely unreachable/non-responding endpoint, not just a fast-failing one (a closed port fails fast; a black-hole address does not).
- A `sessionId` that isn't a well-formed UUID (empty string, malformed, or absent) being fed into the OTLP traceId field, which OTLP/Trail's ingest expects as a specific hex format — must degrade to a valid random traceId rather than send a malformed one.
- `getCompositionView` on a completely unknown traceId (zero spans at all) versus a traceId with spans but none attachment-shaped — the API route must tell these apart (404 vs. 200 with an empty list), matching the existing `/api/v1/harness/:traceId` route's own null-vs-empty convention.

---

## Task 1: Server-side composition view

**Files:**
- Create: `server/src/composition.ts`
- Modify: `server/src/runs.ts` (export `parseRaw`, currently private at `runs.ts:162`)
- Test: `server/test/composition.test.js`

**Interfaces:**
- Consumes: `parseRaw(raw: string): { attrs: AttrMap; events: {...}[]; errorCode: number } | null` (newly exported from `runs.ts`); `asString(v: unknown): string | undefined` and `toIsoOrEmpty(ns: bigint): string` (already exported from `runs.ts`); `Database.Database` from `better-sqlite3`.
- Produces:
  ```ts
  export interface CompositionEntry {
    source: string;
    kind: string;
    nameOrPath: string;
    sizeBytes: number;
    contentPreview?: string;
    sessionId: string;
    timestamp: string;
  }
  export interface CompositionView {
    entries: CompositionEntry[];
  }
  export function getCompositionView(db: Database.Database, traceId: string): CompositionView | null
  ```

In `runs.ts`, change `function parseRaw(` (line 162) to `export function parseRaw(`. No other change to that function.

`getCompositionView` runs its own prepared statement — `SELECT traceId, spanId, parentSpanId, name, startTimeUnixNano, endTimeUnixNano, raw FROM spans WHERE traceId = ? ORDER BY startTimeUnixNano ASC` — the same columns and ordering `getRun` uses, but deliberately *not* calling `getRun` and *not* checking for a root span, since that's precisely the limitation this view exists to avoid. If the query returns zero rows, return `null` (trace doesn't exist at all). Otherwise, for each row: call `parseRaw(row.raw)`; skip the row (don't throw, don't include it) if `parseRaw` returns `null` or `attrs["gen_ai.harness.attachment.kind"]` isn't a non-empty string (unauthenticated ingest, so treat anything unrecognized as "not a composition span," matching `runs.ts`'s existing defensive convention for attribute reads). For a row that does carry it, build a `CompositionEntry`: `source`/`kind`/`nameOrPath` (from attributes `gen_ai.harness.attachment.source`/`.kind`/`.name_or_path` via `asString`, defaulting to `""` if somehow not a string), `sizeBytes` (from `gen_ai.harness.attachment.size_bytes`, `0` if not a number), `contentPreview` (from `gen_ai.harness.attachment.content_preview` via `asString`, omitted if absent), `sessionId` (from `gen_ai.harness.attachment.session_id` via `asString`, `""` if absent), `timestamp` (`toIsoOrEmpty(BigInt(row.startTimeUnixNano))`). Return `{ entries }` — even if `entries` ends up empty, that's a valid 200-worthy result distinct from the `null` (unknown-trace) case.

- [ ] **Step 1: Write the failing tests**

```js
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, insertSpan } from "../dist/db.js";
import { listRuns } from "../dist/runs.js";
import { getCompositionView } from "../dist/composition.js";

function attachmentSpan(traceId, spanId, parentSpanId, overrides = {}) {
  const attrs = {
    "gen_ai.harness.attachment.source": "pre_tool_use_hook",
    "gen_ai.harness.attachment.kind": "tool_file",
    "gen_ai.harness.attachment.name_or_path": "/a/b.ts",
    "gen_ai.harness.attachment.size_bytes": 7,
    "gen_ai.harness.attachment.session_id": "sess-1",
    ...overrides,
  };
  const raw = JSON.stringify({
    attributes: Object.entries(attrs).map(([key, v]) => ({
      key, value: typeof v === "number" ? { intValue: String(v) } : { stringValue: v },
    })),
    status: { code: 1 },
  });
  return { traceId, spanId, parentSpanId, name: "composition_attachment",
    startTimeUnixNano: "1700000000000000000", endTimeUnixNano: "1700000000000000000", raw };
}

describe("getCompositionView", () => {
  test("returns null for a completely unknown traceId", () => {
    const db = openDatabase(":memory:");
    assert.equal(getCompositionView(db, "unknown"), null);
  });

  test("returns entries for a trace with no root span at all (no trail_finish_run)", () => {
    const db = openDatabase(":memory:");
    insertSpan(db, attachmentSpan("t1", "s1", "parent-placeholder"));
    const view = getCompositionView(db, "t1");
    assert.equal(view.entries.length, 1);
    assert.equal(view.entries[0].nameOrPath, "/a/b.ts");
    assert.equal(view.entries[0].kind, "tool_file");
    assert.equal(view.entries[0].sessionId, "sess-1");
  });

  test("returns an empty list (not null) for a trace whose spans carry no attachment attributes", () => {
    const db = openDatabase(":memory:");
    insertSpan(db, { traceId: "t2", spanId: "s1", parentSpanId: null, name: "step",
      startTimeUnixNano: "1700000000000000000", endTimeUnixNano: "1700000000000000000",
      raw: JSON.stringify({ attributes: [], status: { code: 1 } }) });
    const view = getCompositionView(db, "t2");
    assert.deepEqual(view.entries, []);
  });

  test("omits contentPreview when the attribute is absent", () => {
    const db = openDatabase(":memory:");
    insertSpan(db, attachmentSpan("t3", "s1", "parent-placeholder"));
    const view = getCompositionView(db, "t3");
    assert.equal("contentPreview" in view.entries[0], false);
  });

  test("a composition span's non-null parentSpanId never makes it appear in listRuns", () => {
    const db = openDatabase(":memory:");
    insertSpan(db, attachmentSpan("t4", "s1", "parent-placeholder"));
    const runs = listRuns(db, 50);
    assert.equal(runs.some((r) => r.traceId === "t4"), false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npm run build && node --test test/composition.test.js`
Expected: FAIL (module `../dist/composition.js` not found)

- [ ] **Step 3: Export `parseRaw` from `server/src/runs.ts` and implement `getCompositionView` in `server/src/composition.ts`**

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npm run build && node --test test/composition.test.js`
Expected: PASS

- [ ] **Step 5: Run the full server suite to confirm no regressions from exporting `parseRaw`**

Run: `cd server && npm test`
Expected: all existing suites still pass

- [ ] **Step 6: Commit**

```bash
git add server/src/composition.ts server/src/runs.ts server/test/composition.test.js
git commit -m "feat(server): composition view, independent of root-span existence"
```

---

## Task 2: Composition API route

**Files:**
- Modify: `server/src/server.ts` (add route, near the existing `/api/v1/harness/:traceId` handler)
- Test: `server/test/server.test.js` (or wherever the existing `/api/v1/harness/:traceId` route is tested — find and mirror it exactly)

**Interfaces:**
- Consumes: `getCompositionView` (Task 1).

Add `GET /api/v1/composition/:traceId`, matching the existing `/api/v1/harness/:traceId` handler's structure exactly: extract `traceId` from the path the same way that handler does, call `getCompositionView(db, traceId)`, respond `404` with the same error-body shape if it returns `null`, otherwise respond `200` with the view JSON-serialized the same way the harness route does.

- [ ] **Step 1: Write the failing test**

Find the existing test for `/api/v1/harness/:traceId` (or `/api/v1/runs/:traceId`) in `server/test/`, and write one test for the new route following that exact pattern: one case hitting a known traceId with inserted composition spans and asserting the JSON body matches, one case hitting an unknown traceId and asserting `404`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd server && npm run build && npm test -- --test-name-pattern=composition` (or the equivalent filter the existing test file's other route tests use)
Expected: FAIL (route not found / 404 where 200 expected, or vice versa)

- [ ] **Step 3: Add the route in `server/src/server.ts`**

- [ ] **Step 4: Run the test to verify it passes**

Run: same command as Step 2
Expected: PASS

- [ ] **Step 5: Run the full server suite**

Run: `cd server && npm test`
Expected: all suites pass

- [ ] **Step 6: Commit**

```bash
git add server/src/server.ts server/test/server.test.js
git commit -m "feat(server): expose composition data at /api/v1/composition/:traceId"
```

---

## Task 3: Composition span construction (mcp/)

**Files:**
- Create: `mcp/src/hooks/deliver.ts`
- Test: `mcp/test/hooks-deliver.test.js`

**Interfaces:**
- Consumes: `AttachmentEntry` (from `./capture.js`, already shipped); `SpanInput`, `AttrValue`, `hexId`, `nowNanos` from `../otlp.js` (already shipped, already exported).
- Produces:
  ```ts
  export function traceIdFromSessionId(sessionId: string): string
  export function buildAttachmentSpan(entry: AttachmentEntry): SpanInput
  ```

`traceIdFromSessionId(sessionId)`: strip every non-hex character (notably `-`) from `sessionId` and lowercase it. If the result is exactly 32 hex characters, return it — this is a session UUID's 32 hex digits with its dashes removed, which happens to already be exactly OTLP's traceId length. Otherwise (empty, malformed, too short/long), return `hexId(16)` (a random 32-hex-char id) instead — composition entries from a session with no usable id still get a valid, if ungroupable, trace rather than a malformed one.

`buildAttachmentSpan(entry)`: builds a `SpanInput` with `traceId: traceIdFromSessionId(entry.sessionId)`; `spanId: hexId(8)`; `parentSpanId`: a **deterministic, non-null** placeholder derived from the traceId via `createHash("sha256").update(traceId).digest("hex").slice(0, 16)` (import `createHash` from `node:crypto`) — this must never be empty or undefined, since an unset `parentSpanId` is exactly what makes a span satisfy `server/src/runs.ts`'s `listRuns` query (Global Constraints). `name: "composition_attachment"`. `startTimeUnixNano`/`endTimeUnixNano`: both set to the nanosecond conversion of `entry.timestamp` — `(BigInt(Date.parse(entry.timestamp)) * 1_000_000n).toString()` — falling back to `nowNanos()` if `Date.parse` returns `NaN`. `attributes`: `{"gen_ai.harness.attachment.source": entry.source, "gen_ai.harness.attachment.kind": entry.kind, "gen_ai.harness.attachment.name_or_path": entry.nameOrPath, "gen_ai.harness.attachment.size_bytes": entry.sizeBytes, "gen_ai.harness.attachment.session_id": entry.sessionId, "gen_ai.harness.attachment.content_preview": entry.contentPreview}` — passing `entry.contentPreview` through even when `undefined` is fine, since `otlp.ts`'s `toAttributes` already filters out `undefined`/empty-string values before building the OTLP payload.

- [ ] **Step 1: Write the failing tests**

```js
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { traceIdFromSessionId, buildAttachmentSpan } from "../dist/hooks/deliver.js";

describe("traceIdFromSessionId", () => {
  test("strips dashes from a UUID session id", () => {
    const id = traceIdFromSessionId("0f962b5d-b5f1-42e0-a294-03819bc6eb8d");
    assert.equal(id, "0f962b5db5f142e0a29403819bc6eb8d");
  });
  test("falls back to a random 32-hex id for an empty session id", () => {
    const id = traceIdFromSessionId("");
    assert.match(id, /^[0-9a-f]{32}$/);
  });
  test("falls back to a random 32-hex id for a malformed session id", () => {
    const id = traceIdFromSessionId("not-a-uuid");
    assert.match(id, /^[0-9a-f]{32}$/);
  });
});

describe("buildAttachmentSpan", () => {
  const entry = { source: "pre_tool_use_hook", kind: "tool_file", nameOrPath: "/a.ts",
    sizeBytes: 5, timestamp: "2026-11-09T00:00:00.000Z", sessionId: "0f962b5d-b5f1-42e0-a294-03819bc6eb8d" };

  test("derives the traceId from the session id", () => {
    const span = buildAttachmentSpan(entry);
    assert.equal(span.traceId, "0f962b5db5f142e0a29403819bc6eb8d");
  });

  test("parentSpanId is always set, never empty", () => {
    const span = buildAttachmentSpan(entry);
    assert.ok(span.parentSpanId && span.parentSpanId.length > 0);
  });

  test("parentSpanId is deterministic for the same session", () => {
    const a = buildAttachmentSpan(entry);
    const b = buildAttachmentSpan(entry);
    assert.equal(a.parentSpanId, b.parentSpanId);
  });

  test("carries the entry's fields as attributes", () => {
    const span = buildAttachmentSpan(entry);
    assert.equal(span.attributes["gen_ai.harness.attachment.kind"], "tool_file");
    assert.equal(span.attributes["gen_ai.harness.attachment.name_or_path"], "/a.ts");
    assert.equal(span.attributes["gen_ai.harness.attachment.size_bytes"], 5);
  });

  test("omits contentPreview attribute when the entry has none", () => {
    const span = buildAttachmentSpan(entry);
    assert.equal(span.attributes["gen_ai.harness.attachment.content_preview"], undefined);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd mcp && npm run build && node --test test/hooks-deliver.test.js`
Expected: FAIL (module not found)

- [ ] **Step 3: Implement `traceIdFromSessionId` and `buildAttachmentSpan` in `mcp/src/hooks/deliver.ts`**

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd mcp && npm run build && node --test test/hooks-deliver.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add mcp/src/hooks/deliver.ts mcp/test/hooks-deliver.test.js
git commit -m "feat(mcp): build OTLP spans from composition attachment entries"
```

---

## Task 4: Best-effort delivery, wired into the hook

**Files:**
- Modify: `mcp/src/hooks/deliver.ts` (add delivery function)
- Modify: `mcp/src/hooks/run.ts` (call it)
- Test: `mcp/test/hooks-deliver.test.js` (extend), `mcp/test/hooks-cli.test.js` (extend, end-to-end)

**Interfaces:**
- Consumes: `buildAttachmentSpan` (Task 3); `sendSpan`, `TrailConfig` from `../otlp.js`.
- Produces:
  ```ts
  export function configFromEnv(): TrailConfig
  export async function deliverBestEffort(cfg: TrailConfig, entries: AttachmentEntry[], timeoutMs?: number): Promise<void>
  ```

`configFromEnv()` mirrors `mcp/src/index.ts`'s existing config construction exactly: `url: process.env.TRAIL_URL ?? "http://127.0.0.1:4319"`, `publicKey: process.env.TRAIL_PUBLIC_KEY`, `secretKey: process.env.TRAIL_SECRET_KEY`, `environment: process.env.TRAIL_ENV ?? "default"`, `serviceName: process.env.TRAIL_APP ?? "coding-agent"`.

`deliverBestEffort(cfg, entries, timeoutMs = 2000)` never throws and never rejects — wrap its entire body in `try { ... } catch { /* best-effort, discard */ }`. For each entry, build its span with `buildAttachmentSpan` and attempt `sendSpan(cfg, span)` raced against a timeout: `await Promise.race([sendSpan(cfg, span), new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), timeoutMs))])`, with that individual attempt's own `try/catch` so one entry's failure doesn't stop the rest from being attempted. Do not modify `otlp.ts`'s `sendSpan` itself — the timeout lives entirely on this module's side, so the function used by the main (non-hook) MCP tool-call path is untouched.

In `mcp/src/hooks/run.ts`'s `runHook`, after the existing `appendEntries(logDir, entries)` and `writeOffset(...)` calls succeed, add one more step: `await deliverBestEffort(configFromEnv(), entries).catch(() => {})` (the outer `.catch` is a backstop in case `deliverBestEffort` somehow still throws; it shouldn't, given its own internal try/catch, but `run.ts`'s whole-function guarantee doesn't rely on that alone). If `appendEntries`/`writeOffset` themselves fail (caught by `runHook`'s existing outer try/catch), delivery is never attempted — local capture succeeding is the precondition for attempting delivery, not the other way around.

- [ ] **Step 1: Write the failing tests**

```js
// Add to mcp/test/hooks-deliver.test.js
import { createServer } from "node:http";
import { deliverBestEffort } from "../dist/hooks/deliver.js";

describe("deliverBestEffort", () => {
  test("posts each entry to a reachable server", async () => {
    const received = [];
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => { received.push(JSON.parse(body)); res.writeHead(200).end(); });
    });
    await new Promise((resolve) => server.listen(0, resolve));
    const port = server.address().port;
    const entry = { source: "pre_tool_use_hook", kind: "tool_file", nameOrPath: "/a.ts",
      sizeBytes: 5, timestamp: "2026-11-09T00:00:00.000Z", sessionId: "s1" };
    await deliverBestEffort({ url: `http://127.0.0.1:${port}`, environment: "default", serviceName: "test" }, [entry]);
    assert.equal(received.length, 1);
    server.close();
  });

  test("does not throw and resolves within the timeout budget when the endpoint is unreachable", async () => {
    const entry = { source: "pre_tool_use_hook", kind: "tool_file", nameOrPath: "/a.ts",
      sizeBytes: 5, timestamp: "2026-11-09T00:00:00.000Z", sessionId: "s1" };
    const start = Date.now();
    await assert.doesNotReject(() =>
      deliverBestEffort({ url: "http://10.255.255.1", environment: "default", serviceName: "test" }, [entry], 500),
    );
    assert.ok(Date.now() - start < 2000, "delivery must not block well past its own timeout budget");
  });
});
```

```js
// Add to mcp/test/hooks-cli.test.js
test("runHook still writes the local log even when delivery is unreachable", async () => {
  // same shape as this file's existing runHook tests: set scratchpad_dir to a
  // tmp dir, set TRAIL_URL (via env override passed to the child process, or
  // directly to runHook if invoked in-process) to an unreachable address,
  // and assert the composition log file is still written with the expected
  // entry despite delivery failing.
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd mcp && npm run build && node --test test/hooks-deliver.test.js test/hooks-cli.test.js`
Expected: FAIL (`deliverBestEffort`/`configFromEnv` not found; the new `hooks-cli` case fails because `run.ts` doesn't call delivery yet, so there's nothing to assert against — adjust the exact failure expectation once you see it, the point is it must fail before the implementation exists)

- [ ] **Step 3: Implement `configFromEnv` and `deliverBestEffort` in `mcp/src/hooks/deliver.ts`; wire the call into `mcp/src/hooks/run.ts`**

- [ ] **Step 4: Run tests to verify they pass**

Run: same command as Step 2
Expected: PASS

- [ ] **Step 5: Run the full mcp suite**

Run: `cd mcp && npm test`
Expected: all suites pass, including every test from the previous plan

- [ ] **Step 6: Commit**

```bash
git add mcp/src/hooks/deliver.ts mcp/src/hooks/run.ts mcp/test/hooks-deliver.test.js mcp/test/hooks-cli.test.js
git commit -m "feat(mcp): best-effort, timeout-bounded delivery of composition data to Trail"
```

---

## Task 5: Documentation and version bump

**Files:**
- Modify: `mcp/README.md`
- Modify: `mcp/package.json`
- Modify: `server/README.md` (if it documents the existing `/api/v1/*` routes — check for that section first; add alongside it if so, otherwise skip this file)

**Interfaces:**
- Consumes: nothing new — documents Tasks 1–4's shipped behavior.

- [ ] **Step 1: Update `mcp/README.md`'s "Composition capture (hooks)" section**

Add: composition entries are now also delivered live, best-effort, to the same `TRAIL_URL` the MCP server itself uses (local mode by default, or Trail Cloud if configured) — this is in addition to, not instead of, the local JSONL log, which remains the durable record regardless of delivery success. State the ~2-second timeout budget and that delivery failure is silent and never affects the hook's own exit code or the agent's tool-call flow.

- [ ] **Step 2: Update (or add, if missing) a short section in `server/README.md` documenting `/api/v1/composition/:traceId`**

Mirror however the existing `/api/v1/harness/:traceId` / `/api/v1/runs/:traceId` routes are documented there (if they are). State plainly that this route works even for a trace with no completed run (no UI consumes it yet).

- [ ] **Step 3: Bump `mcp/package.json`'s version from `0.5.0` to `0.6.0`**

A new, backward-compatible capability — matches the established minor-bump-per-feature convention.

- [ ] **Step 4: Commit**

```bash
git add mcp/README.md mcp/package.json server/README.md
git commit -m "docs: document composition delivery and the /api/v1/composition route; bump mcp to 0.6.0"
```
