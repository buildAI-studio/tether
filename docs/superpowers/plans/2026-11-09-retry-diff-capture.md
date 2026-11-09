# Retry-Diff Capture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When `detectRetries()` flags a run of same-title failed steps, show what the agent's structured tool-call args actually changed between consecutive attempts, not just "same failure as before."

**Architecture:** A new server-side function diffs each retried step's decoded `"Input"` value against the immediately preceding attempt's, one level of keys deep, attaching the result to the existing `RetrySignal` the retry-detection loop already produces. The client renders that diff in the step inspector, directly below the existing retry badge, reusing the JSON-tree renderer Phase 1 already built. No MCP/producer change.

**Tech Stack:** TypeScript, `better-sqlite3`, `node:test`, vanilla browser JS (classic script, no bundler).

**Spec:** `docs/superpowers/specs/2026-11-09-retry-diff-capture-design.md`

## Global Constraints

- Every function added to `server/src/runs.ts` degrades to `undefined`/`[]` on anything unexpected — never throws. (Matches the file's existing header comment and every existing function in it.)
- No new MCP tool, parameter, or schema change; no `mcp/` version bump; no server storage-schema change.
- Reuse the existing `renderJsonNode()` (`server/src/static/app.ts`) for displaying `before`/`after` values — do not invent a new JSON-rendering convention.
- Do not reuse `DiffView`/`renderDiffs()` — that shape (unified-diff text + hunk/truncation metadata) is for agent-reported file content, a different kind of diff from a server-computed shallow key comparison.
- `null` is explicitly excluded from "structured object": the check is `v !== null && typeof v === "object" && !Array.isArray(v)`, never the version without the `v !== null` guard.
- `argsDiff` is attached to a `RetrySignal` via conditional spread (`...(argsDiff ? { argsDiff } : {})`), never as an always-present key — an existing test in `server/test/runs.test.js` uses `assert.deepEqual` under `node:assert/strict` (i.e. `deepStrictEqual`), which treats an extra `argsDiff: undefined` own key as a mismatch.
- `argsDiff` lives on the individual `RetrySignal` it describes (`sg.argsDiff`), not as one block appended once after the whole `sig` array.
- The diff compares each attempt against the one immediately before it in the same retry run, not against the first attempt.
- When both attempts' decoded `"Input"` is a structured object, `argsDiff` is always present — even as an empty array, meaning "retried with identical arguments." That is a distinct state from the field being absent (comparison wasn't possible at all), and the UI must render the two states with different copy.
- `server/test/app.test.js`'s fake-DOM harness gets genuinely extended (`querySelectorAll` made to actually match elements) so pinned-step rendering is reachable the normal way — not a narrower workaround that leaves the underlying gap for the next phase.

## Review Focus

- A step's decoded `"Input"` is a JSON array (e.g. positional tool args), not a plain object — must yield an absent `argsDiff`, not a nonsensical index-keyed diff. (Task 1)
- A step has no `"Input"` entry in `io` at all (a reason-only or exception-only step that never logged a prompt) — must not throw. (Task 1)
- A step's decoded `"Input"` is JSON `null` for one or both attempts — must be treated as non-object, not crash on `Object.keys(null)`. (Task 1)
- A changed key's value is itself a nested object or array — the shallow diff must still flag it as changed (via value-equality, not reference-equality) and the UI must render the nested `before`/`after` values without crashing. (Task 1 for detection, Task 2 for rendering)
- A key name or a string value contains HTML-special characters (`<`, `&`, a literal `</div>` or `<script>`) — must render escaped in the UI, never break out of its container. (Task 2)

---

### Task 1: Diff structured args between retry attempts

**Files:**
- Modify: `server/src/runs.ts` (`RetrySignal` interface at line 12; `detectRetries()` at line 241)
- Test: `server/test/runs.test.js`

**Interfaces:**
- Consumes: `StepView.io: [string, string | unknown][]` (already exists — a `"Input"` entry's value is `decodeIoValue()`'s result: a parsed JS value for Phase-1-or-later structured args, or the original string for legacy data).
- Produces: `RetrySignal.argsDiff?: { key: string; before: unknown; after: unknown }[]`, consumed by Task 2's rendering code.

Change `RetrySignal` (currently `{ kind: "retry"; count: number; detail: string }`) to:

```ts
export interface RetrySignal {
	kind: "retry";
	count: number;
	detail: string;
	argsDiff?: { key: string; before: unknown; after: unknown }[];
}
```

Add a helper that extracts a step's decoded `"Input"` value:

```ts
function stepInput(step: StepView): unknown {
	return step.io.find(([label]) => label === "Input")?.[1];
}
```

Add `isStructuredObject(v: unknown): v is Record<string, unknown>` returning `v !== null && typeof v === "object" && !Array.isArray(v)`.

Add `buildArgsDiff(prev: StepView, cur: StepView): RetrySignal["argsDiff"]`: get both steps' `stepInput()`; if either fails `isStructuredObject`, return `undefined`. Otherwise, over the union of both objects' own keys, build one `{ key, before, after }` entry per key where the two sides differ — comparing by presence first (a key present on only one side always counts as differing, with the other side's value as `undefined`), then by `JSON.stringify` equality for keys present on both sides. Return the resulting array (possibly empty — do not return `undefined` for an empty result; empty-but-computed and "couldn't compare" are different states per the Global Constraints).

Wire it into `detectRetries()`'s existing loop: for each `k` from `i + 1` to `j - 1` (the same range that already gets a `sig`), compute `const argsDiff = buildArgsDiff(steps[k - 1], steps[k]);` and change the signal object from `{ kind: "retry", count, detail: ... }` to `{ kind: "retry", count, detail: ..., ...(argsDiff ? { argsDiff } : {}) }`.

- [ ] **Step 1: Write the failing tests**

Add to `server/test/runs.test.js`, inside the existing retry `describe` block (use `structuredStepSpan()` for structured-arg fixtures, same helper Phase 1's own tests already use):

```js
test("includes an argsDiff with one entry per changed key between consecutive retry attempts", () => {
	const dbPath = makeTempDbPath();
	const db = openDatabase(dbPath);
	try {
		insertSpan(db, rootSpan({ traceId: "t20", spanId: "r20", goal: "g", agent: "a", startNs: "1000000000000", endNs: "1100000000000" }));
		const inputs = [{ file: "a.ts", text: "x" }, { file: "a.ts", text: "y" }, { file: "b.ts", text: "y" }];
		inputs.forEach((input, i) => {
			const ns = String(1010000000000 + i * 2000000000);
			insertSpan(db, structuredStepSpan({ traceId: "t20", spanId: "s" + i, parentSpanId: "r20", name: "edit_file", startNs: ns, endNs: String(Number(ns) + 1000000000), toolName: "edit_file", isError: true, input }));
		});
		const run = getRun(db, "t20");
		assert.equal(run.steps[0].sig, undefined);
		assert.deepEqual(run.steps[1].sig[0].argsDiff, [{ key: "text", before: "x", after: "y" }]);
		assert.deepEqual(run.steps[2].sig[0].argsDiff, [{ key: "file", before: "a.ts", after: "b.ts" }]);
	} finally {
		db.close();
		rmSync(join(dbPath, ".."), { recursive: true, force: true });
	}
});

test("includes an empty argsDiff when a retry attempt repeats identical structured args", () => {
	const dbPath = makeTempDbPath();
	const db = openDatabase(dbPath);
	try {
		insertSpan(db, rootSpan({ traceId: "t21", spanId: "r21", goal: "g", agent: "a", startNs: "1000000000000", endNs: "1100000000000" }));
		for (let i = 0; i < 3; i++) {
			const ns = String(1010000000000 + i * 2000000000);
			insertSpan(db, structuredStepSpan({ traceId: "t21", spanId: "s" + i, parentSpanId: "r21", name: "edit_file", startNs: ns, endNs: String(Number(ns) + 1000000000), toolName: "edit_file", isError: true, input: { file: "a.ts" } }));
		}
		const run = getRun(db, "t21");
		assert.deepEqual(run.steps[1].sig[0].argsDiff, []);
		assert.deepEqual(run.steps[2].sig[0].argsDiff, []);
	} finally {
		db.close();
		rmSync(join(dbPath, ".."), { recursive: true, force: true });
	}
});

test("omits argsDiff entirely when a retry attempt's args are legacy plain-text, not structured", () => {
	const dbPath = makeTempDbPath();
	const db = openDatabase(dbPath);
	try {
		insertSpan(db, rootSpan({ traceId: "t22", spanId: "r22", goal: "g", agent: "a", startNs: "1000000000000", endNs: "1100000000000" }));
		for (let i = 0; i < 3; i++) {
			const ns = String(1010000000000 + i * 2000000000);
			// A plain, non-JSON prompt string: decodeIoValue's JSON.parse fails and it falls back to
			// the raw string (pre-Phase-1 shape), which must fail isStructuredObject.
			insertSpan(db, stepSpan({ traceId: "t22", spanId: "s" + i, parentSpanId: "r22", name: "run tests", startNs: ns, endNs: String(Number(ns) + 1000000000), toolName: "run tests", isError: true, prompt: "run the suite" }));
		}
		const run = getRun(db, "t22");
		assert.deepEqual(run.steps[1].sig, [{ kind: "retry", count: 2, detail: run.steps[1].sig[0].detail }]);
		assert.equal("argsDiff" in run.steps[1].sig[0], false);
	} finally {
		db.close();
		rmSync(join(dbPath, ".."), { recursive: true, force: true });
	}
});

test("omits argsDiff when a retried attempt's structured Input is a JSON array, not an object", () => {
	const dbPath = makeTempDbPath();
	const db = openDatabase(dbPath);
	try {
		insertSpan(db, rootSpan({ traceId: "t23", spanId: "r23", goal: "g", agent: "a", startNs: "1000000000000", endNs: "1100000000000" }));
		for (let i = 0; i < 3; i++) {
			const ns = String(1010000000000 + i * 2000000000);
			insertSpan(db, structuredStepSpan({ traceId: "t23", spanId: "s" + i, parentSpanId: "r23", name: "batch_run", startNs: ns, endNs: String(Number(ns) + 1000000000), toolName: "batch_run", isError: true, input: ["a", "b"] }));
		}
		const run = getRun(db, "t23");
		assert.equal("argsDiff" in run.steps[1].sig[0], false);
	} finally {
		db.close();
		rmSync(join(dbPath, ".."), { recursive: true, force: true });
	}
});

test("omits argsDiff when a retried attempt's structured Input is JSON null", () => {
	const dbPath = makeTempDbPath();
	const db = openDatabase(dbPath);
	try {
		insertSpan(db, rootSpan({ traceId: "t24", spanId: "r24", goal: "g", agent: "a", startNs: "1000000000000", endNs: "1100000000000" }));
		for (let i = 0; i < 3; i++) {
			const ns = String(1010000000000 + i * 2000000000);
			insertSpan(db, structuredStepSpan({ traceId: "t24", spanId: "s" + i, parentSpanId: "r24", name: "ping", startNs: ns, endNs: String(Number(ns) + 1000000000), toolName: "ping", isError: true, input: null }));
		}
		const run = getRun(db, "t24");
		assert.equal("argsDiff" in run.steps[1].sig[0], false);
	} finally {
		db.close();
		rmSync(join(dbPath, ".."), { recursive: true, force: true });
	}
});

test("omits argsDiff when a retried step has no Input entry at all", () => {
	const dbPath = makeTempDbPath();
	const db = openDatabase(dbPath);
	try {
		insertSpan(db, rootSpan({ traceId: "t25", spanId: "r25", goal: "g", agent: "a", startNs: "1000000000000", endNs: "1100000000000" }));
		for (let i = 0; i < 3; i++) {
			const ns = String(1010000000000 + i * 2000000000);
			// stepSpan with no prompt/completion -- no "Input" entry ends up in io at all.
			insertSpan(db, stepSpan({ traceId: "t25", spanId: "s" + i, parentSpanId: "r25", name: "noop", startNs: ns, endNs: String(Number(ns) + 1000000000), toolName: "noop", isError: true }));
		}
		const run = getRun(db, "t25");
		assert.equal("argsDiff" in run.steps[1].sig[0], false);
	} finally {
		db.close();
		rmSync(join(dbPath, ".."), { recursive: true, force: true });
	}
});

test("flags a changed key via value-equality even when the value is a nested object", () => {
	const dbPath = makeTempDbPath();
	const db = openDatabase(dbPath);
	try {
		insertSpan(db, rootSpan({ traceId: "t26", spanId: "r26", goal: "g", agent: "a", startNs: "1000000000000", endNs: "1100000000000" }));
		const inputs = [{ opts: { retries: 1 } }, { opts: { retries: 2 } }];
		inputs.forEach((input, i) => {
			const ns = String(1010000000000 + i * 2000000000);
			insertSpan(db, structuredStepSpan({ traceId: "t26", spanId: "s" + i, parentSpanId: "r26", name: "call", startNs: ns, endNs: String(Number(ns) + 1000000000), toolName: "call", isError: true, input }));
		});
		// A 3rd identical-to-2nd attempt so the retry-run threshold (3) is met.
		insertSpan(db, structuredStepSpan({ traceId: "t26", spanId: "s2", parentSpanId: "r26", name: "call", startNs: "1014000000000", endNs: "1015000000000", toolName: "call", isError: true, input: inputs[1] }));
		const run = getRun(db, "t26");
		assert.deepEqual(run.steps[1].sig[0].argsDiff, [{ key: "opts", before: { retries: 1 }, after: { retries: 2 } }]);
	} finally {
		db.close();
		rmSync(join(dbPath, ".."), { recursive: true, force: true });
	}
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npm run build && node --test test/runs.test.js`
Expected: FAIL — `argsDiff` is `undefined` everywhere (property doesn't exist yet), or build errors if the type isn't declared yet.

- [ ] **Step 3: Implement `stepInput`, `isStructuredObject`, `buildArgsDiff`, and wire into `detectRetries()`**

Per the signatures and algorithm above. Place `stepInput`/`isStructuredObject`/`buildArgsDiff` near `detectRetries()` in `server/src/runs.ts`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npm run build && node --test test/runs.test.js`
Expected: PASS (all 7 new tests, plus the 2 pre-existing retry tests unaffected).

- [ ] **Step 5: Run the full server test suite**

Run: `cd server && npm test`
Expected: PASS, no regressions.

- [ ] **Step 6: Commit**

```bash
git add server/src/runs.ts server/test/runs.test.js
git commit -m "feat(server): diff structured tool-call args between retry attempts"
```

---

### Task 2: Render the args diff in the step inspector

**Files:**
- Modify: `server/src/static/app.ts` (`renderStepIO()` at line 346)
- Modify: `server/src/templates/shell.ts` (CSS, near the existing `.io-sig`/`.io-json` rules around line 217-223)
- Modify: `server/test/app.test.js` (extend the fake-DOM harness; add rendering tests)

**Interfaces:**
- Consumes: `RetrySignal.argsDiff?: { key: string; before: unknown; after: unknown }[]` from Task 1. `renderJsonNode(v: unknown): string` (already exists, line 79).
- Produces: nothing a later task consumes — this is the last task.

**Part A — extend the fake-DOM harness so pinned-step rendering is reachable**

Today, `FakeElement.querySelectorAll()` always returns `[]` and the `innerHTML` setter only special-cases scanning for an embedded `<script id="...">` tag. `renderSteps()`'s click-wiring (`app.ts` line 277: `el.querySelectorAll<HTMLElement>(".step").forEach((node) => node.addEventListener("click", ...))`) can therefore never attach, so no existing test can simulate a user clicking a step to pin it.

In `server/test/app.test.js`'s `FakeElement` class:

- Add `this._scanned = []` in the constructor (a list of child `FakeElement`s found in the last-assigned `innerHTML`, distinct from `this.children`, which `appendChild` already uses for a different purpose).
- In the `innerHTML` setter, before/alongside the existing script-tag scan, reset `this._scanned = []` then scan for `renderSteps()`'s exact step markup. Use `v.matchAll(/<div class="step" data-i="(\d+)"/g)` (a fresh regex literal written at the call site, not a `/g`-flagged regex stored in a shared variable and reused across calls via `.exec()` — that pattern carries `lastIndex` state between calls and silently misses matches on a later, unrelated `innerHTML` assignment). For each match, create `const child = new FakeElement(null); child.dataset.i = match[1]; child._classes = new Set(["step"]); this._scanned.push(child);`. This is deliberately narrow — it matches exactly what `renderSteps()` emits today, not a general HTML parser, because that's the only markup this harness needs to make reachable.
- Replace `querySelectorAll() { return []; }` with a version that supports a single leading-dot class selector: parse the selector, strip the leading `.`, and return `this._scanned.filter((el) => el._classes?.has(className))`. A selector not starting with `.` returns `[]` (no other form is used against freshly-rendered `innerHTML` content in production code).
- Add `click() { (this._listeners.click ?? []).forEach((fn) => fn()); }` to `FakeElement`, so a test can simulate a user click the same way a real DOM test would, using the `addEventListener`/`_listeners` mechanism the class already has.

- [ ] **Step 1: Write a failing test proving the harness extension works**

```js
test("querySelectorAll(\".step\") finds rendered step elements and their click listener is reachable", () => {
	const { elements, mountDetailPanel } = loadApp();
	mountDetailPanel(makeRunData({ steps: [
		{ type: "tool", title: "a", status: "ok", start: 0, dur: 1, cost: null, tok: null, io: [] },
		{ type: "tool", title: "b", status: "ok", start: 1, dur: 1, cost: null, tok: null, io: [] },
	] }));
	const stepEls = elements.steps.querySelectorAll(".step");
	assert.equal(stepEls.length, 2);
	stepEls[1].click();
	assert.match(elements.insp.innerHTML, /step 2/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npm run build && node --test test/app.test.js`
Expected: FAIL — `querySelectorAll` returns `[]`, so `stepEls.length` is `0`, not `2`.

- [ ] **Step 3: Implement the harness extension**

Per Part A above.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npm run build && node --test test/app.test.js`
Expected: PASS.

**Part B — render `argsDiff` in the inspector**

In `renderStepIO()` (`app.ts` line 346), change the `s.sig` rendering (line 350) from building only the `.io-sig` block to also appending, per signal, the argsDiff block:

```ts
if (s.sig) inner += s.sig.map((sg) => {
	let block = '<div class="io-sig">' + /* existing markup, unchanged */ + "</div>";
	if (sg.argsDiff) {
		block += sg.argsDiff.length
			? '<div class="argdiff">' + sg.argsDiff.map((d) =>
				'<div class="argdiff-row"><div class="io-kind">' + escapeHtml(d.key) + '</div>'
				+ '<div class="argdiff-vals">'
				+ '<div><div class="io-kind">Before</div><div class="io-json">' + renderJsonNode(d.before) + '</div></div>'
				+ '<div><div class="io-kind">After</div><div class="io-json">' + renderJsonNode(d.after) + '</div></div>'
				+ '</div></div>'
			).join("") + '</div>'
			: '<div class="insp-empty">Retried with the exact same arguments.</div>';
	}
	return block;
}).join("");
```

Add to `server/src/templates/shell.ts`, near the existing `.io-sig`/`.io-json` rules:

```css
.argdiff { margin-top: 10px; }
.argdiff-row { margin-bottom: 10px; }
.argdiff-row:last-child { margin-bottom: 0; }
.argdiff-vals { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 2px; }
```

- [ ] **Step 5: Write failing tests**

```js
test("renders a key/before/after row for each changed arg when a pinned step has a non-empty argsDiff", () => {
	const { elements, mountDetailPanel } = loadApp();
	mountDetailPanel(makeRunData({ steps: [
		{ type: "tool", title: "edit_file", status: "err", start: 0, dur: 1, cost: null, tok: null, io: [],
			sig: [{ kind: "retry", count: 2, detail: "Attempt 2", argsDiff: [{ key: "text", before: "x", after: "y" }] }] },
	] }));
	elements.steps.querySelectorAll(".step")[0].click();
	assert.match(elements.insp.innerHTML, /argdiff-row/);
	assert.match(elements.insp.innerHTML, />text</);
	assert.match(elements.insp.innerHTML, />Before</);
	assert.match(elements.insp.innerHTML, />After</);
});

test("renders the identical-arguments message when a pinned step has an empty argsDiff", () => {
	const { elements, mountDetailPanel } = loadApp();
	mountDetailPanel(makeRunData({ steps: [
		{ type: "tool", title: "edit_file", status: "err", start: 0, dur: 1, cost: null, tok: null, io: [],
			sig: [{ kind: "retry", count: 2, detail: "Attempt 2", argsDiff: [] }] },
	] }));
	elements.steps.querySelectorAll(".step")[0].click();
	assert.match(elements.insp.innerHTML, /Retried with the exact same arguments\./);
	assert.doesNotMatch(elements.insp.innerHTML, /argdiff-row/);
});

test("renders no argsDiff block when a pinned step's signal has no argsDiff field", () => {
	const { elements, mountDetailPanel } = loadApp();
	mountDetailPanel(makeRunData({ steps: [
		{ type: "tool", title: "run tests", status: "err", start: 0, dur: 1, cost: null, tok: null, io: [],
			sig: [{ kind: "retry", count: 2, detail: "Attempt 2" }] },
	] }));
	elements.steps.querySelectorAll(".step")[0].click();
	assert.doesNotMatch(elements.insp.innerHTML, /argdiff/);
	assert.doesNotMatch(elements.insp.innerHTML, /Retried with the exact same arguments\./);
});

test("escapes an argsDiff key and value that contain HTML-special characters", () => {
	const { elements, mountDetailPanel } = loadApp();
	mountDetailPanel(makeRunData({ steps: [
		{ type: "tool", title: "edit_file", status: "err", start: 0, dur: 1, cost: null, tok: null, io: [],
			sig: [{ kind: "retry", count: 2, detail: "Attempt 2", argsDiff: [{ key: "<script>", before: "</div>", after: "ok" }] }] },
	] }));
	elements.steps.querySelectorAll(".step")[0].click();
	assert.doesNotMatch(elements.insp.innerHTML, /<script>/);
	assert.match(elements.insp.innerHTML, /&lt;script&gt;/);
});

test("renders a nested object's before/after values via the JSON tree renderer without crashing", () => {
	const { elements, mountDetailPanel } = loadApp();
	mountDetailPanel(makeRunData({ steps: [
		{ type: "tool", title: "call", status: "err", start: 0, dur: 1, cost: null, tok: null, io: [],
			sig: [{ kind: "retry", count: 2, detail: "Attempt 2", argsDiff: [{ key: "opts", before: { retries: 1 }, after: { retries: 2 } }] }] },
	] }));
	elements.steps.querySelectorAll(".step")[0].click();
	assert.match(elements.insp.innerHTML, /jv-node/);
	assert.match(elements.insp.innerHTML, /retries/);
});
```

- [ ] **Step 6: Run tests to verify they fail**

Run: `cd server && npm run build && node --test test/app.test.js`
Expected: FAIL — no `argdiff*` markup exists yet.

- [ ] **Step 7: Implement Part B's rendering change and CSS**

- [ ] **Step 8: Run tests to verify they pass**

Run: `cd server && npm run build && node --test test/app.test.js`
Expected: PASS (all 6 new tests from this task, plus every pre-existing `app.test.js` test unaffected).

- [ ] **Step 9: Run the full server test suite**

Run: `cd server && npm test`
Expected: PASS, no regressions.

- [ ] **Step 10: Commit**

```bash
git add server/src/static/app.ts server/src/templates/shell.ts server/test/app.test.js
git commit -m "feat(app): render retry-attempt argument diffs in the step inspector"
```
