# Retry-Diff Capture — Design

## Intent and why

Tether's `detectRetries()` (`server/src/runs.ts`) already flags a run of three
or more consecutive same-title failed steps, stamping each repeat with a
`RetrySignal` whose `detail` reads e.g. `Attempt 3 of "edit_file" — same
failure as before.` That tells a developer debugging their own agent *that*
it kept failing, not *what the agent tried differently* between attempts —
today the only way to find out is to open each failed step's Input manually
and eyeball the difference.

Phase 1 of the rich-data roadmap (shipped, `mcp` 0.2.0→0.3.0) already
replaced the old opaque `input` string with real structured JSON on
`trail_log_step`, decoded server-side via `decodeIoValue()`. That data has
been sitting there, unused for this purpose, since. This phase closes that
gap: when steps are already flagged as a retry run, diff each one's
structured args against the attempt immediately before it, and show the
diff next to the existing retry badge.

## Goals

- For each step inside a detected retry run (`runLength >= MIN_RETRY_RUN`),
  compute a shallow, one-level diff between its decoded `"Input"` value and
  the immediately preceding attempt's, when both are structured objects.
- Surface that diff in the Flight Recorder's step inspector, next to the
  existing "Retry loop ×N" badge and detail line.
- Server-side only. No MCP/producer schema change, no `mcp/` version bump,
  no storage-schema change — this is a new interpretation of data Tether
  already stores, matching how the roadmap framed this phase.
- Degrade gracefully, consistent with every other function in
  `server/src/runs.ts`: malformed, missing, or legacy (pre-Phase-1,
  non-JSON) args never throw and never block the rest of the run from
  rendering.

## Non-goals

- Diffing the error/exception text or stack trace between attempts — only
  the tool-call args.
- Deep/nested diffing. One level of keys is enough for real tool-call
  schemas (flat records of scalars, strings, and the occasional array);
  going deeper is added complexity for a case this phase doesn't need yet.
- Backfilling or reinterpreting already-ingested legacy runs. A run whose
  retried steps predate Phase 1 (plain-string `Input`, not JSON) simply
  gets no diff — the existing plain-text detail stands alone, as it does
  today.
- Any new MCP tool, tool parameter, or producer-side field. Nothing in
  `mcp/` changes for this phase.
- A general-purpose step-to-step diff feature. This is scoped strictly to
  steps already inside a detected retry run; it does not apply to two
  unrelated steps that happen to share a title.

## Anti-goals

(What would make this a failure even if it technically runs.)

- Showing "no changes" when the args actually did change (a wrong diff is
  worse than no diff — a developer would stop checking for themselves).
- Crashing or blanking the whole run view because one retried step's args
  were malformed. The rest of the run — and the rest of that step's own
  data — must still render.
- Silently applying this to every step regardless of retry status, which
  would be a different, unscoped feature wearing this one's name.

## Constraints

- Must fit `server/src/runs.ts`'s existing house style: every function here
  degrades to `null`/`[]`/`undefined` on anything unexpected rather than
  throwing, per the file's own header comment.
- Must use the existing `RetrySignal`/`StepView` types as the extension
  point — add a field, don't replace the existing `detail` string or the
  existing retry-run-detection logic in `detectRetries()`.
- Must reuse the existing `renderJsonNode()` tree-view renderer
  (`server/src/static/app.ts`) for displaying `before`/`after` structured
  values, the same renderer Phase 1 already built for the Input/Output
  panes — not a new JSON-rendering convention.
- Must not reuse `DiffView`/`renderDiffs()` (the unified-diff-text,
  hunk-truncation-metadata shape for agent-*reported* file content). This
  is a server-*computed* shallow key comparison over two already-decoded
  JS values — a different kind of diff, and forcing it into the file-diff
  shape would carry hunk/truncation fields that don't apply here.
- Test coverage must span the same layers prior phases did: pure-function
  tests in `server/test/runs.test.js` (real `detectRetries`/diff-building
  behavior against constructed `StepView`s), and rendering tests in
  `server/test/app.test.js` (real DOM output via the existing vm-based
  harness), matching this repo's established per-layer test convention.

## Decided (my calls, from the brainstorming exchange)

- **Compared against the immediately preceding attempt**, not the first
  attempt in the run. `attempt k` diffs against `attempt k-1`, not
  `attempt i` (the first). This answers "what did I just change" rather
  than "how far have I drifted from the start," which is the more useful
  question when staring at a live retry loop.
- **Diff computed only when both attempts' decoded `"Input"` value is a
  plain object** (not an array, not a primitive, not a bare string). If
  either side isn't a plain object — legacy plain-text data, a tool with
  no structured args, or a tool whose arg schema happens to be an array —
  the new field is simply absent and today's plain-text detail stands
  alone.
- **When both sides are structured objects, the new field is always
  present, even if the objects are identical.** An empty array
  (`argsDiff: []`) is itself a meaningful, distinct signal — "the agent
  retried with the exact same arguments" is different information from
  "we don't know whether the arguments changed" (field absent entirely).
  The UI must render these two states with different copy.
- **Diff shape**, added to `RetrySignal`:
  ```ts
  export interface RetrySignal {
  	kind: "retry";
  	count: number;
  	detail: string;
  	argsDiff?: { key: string; before: unknown; after: unknown }[];
  }
  ```
  One entry per key that differs, across the union of both objects' own
  keys (a key present on only one side counts as differing, with the
  missing side's value represented as `undefined`). Equality is decided
  by `JSON.stringify` comparison of each side's value, with an explicit
  presence check first (since `JSON.stringify(undefined) === undefined`,
  not the string `"undefined"` — a naive stringify-and-compare would
  mishandle a present-but-`undefined`-valued key vs. an absent key).
- **Computed by a new function**, e.g.
  `buildArgsDiff(prevStep: StepView, curStep: StepView): RetrySignal["argsDiff"]`,
  called from inside `detectRetries()`'s existing loop, which already has
  `i`/`k` indices into `steps` and already knows which steps are
  consecutive repeats of the same failure.
- **Redaction is already handled.** Phase 1's `sanitize()` (`mcp/src/sanitize.ts`)
  runs producer-side, inside the MCP server attached to the coding agent,
  redacting and truncating every string leaf before the OTLP payload is
  ever sent over the wire — not on the Tether server itself, which has no
  `sanitize()` call anywhere in `server/src/`. Either way, the data that
  reaches `runs.ts` is already sanitized by the time it's stored, so this
  phase diffs already-sanitized values and introduces no new redaction
  surface.
- **`null` is explicitly excluded from "plain object."** `typeof null ===
  "object"` in JS, so the structured-object check must be
  `v !== null && typeof v === "object" && !Array.isArray(v)` — not just
  `typeof v === "object" && !Array.isArray(v)`, which would wrongly accept
  `null` and then break on `Object.keys(null)`/`Object.entries(null)`
  inside the diff-building function. A step whose decoded `"Input"` is
  JSON `null` is treated the same as a non-object: no diff computed, field
  absent.
- **`argsDiff` must be attached via conditional spread, never an always-
  present key.** `server/test/runs.test.js` uses `assert.deepEqual` with
  `node:assert/strict`, which is actually `assert.deepStrictEqual` and
  treats an extra `argsDiff: undefined` own key as a real mismatch against
  a plain `{kind, count, detail}` object. The existing retry test
  (`stepSpan()`'s plain-string prompts, pre-Phase-1 shape) must keep
  producing a signal with no `argsDiff` key at all — use
  `...(argsDiff ? { argsDiff } : {})`, the same conditional-spread pattern
  `runs.ts` already uses for `diffs`/`sourceType`/`sourceName` on
  `StepView`, not an assignment that could leave the key present-but-
  `undefined`.
- **`argsDiff` lives on each individual `RetrySignal`, not as one combined
  block after the whole `sig` array.** `sig` is typed as an array to allow
  multiple signals per step, so `argsDiff` belongs on the signal it
  describes (`sg.argsDiff`) and renders inside the existing `sig.map(...)`
  iteration in `app.ts` — not as a separate block appended once after it.
  With today's data `detectRetries()` only ever produces one signal per
  step, so this is behaviorally identical either way right now; it's
  decided this way so the type and the rendering stay consistent if that
  ever changes.
- **UI placement**: in the step inspector, directly below the existing
  `.io-sig` block (`"Retry loop ×N"` + `detail`), for steps that have a
  non-empty `sig`. Each `argsDiff` entry renders as its key, then its
  `before` and `after` values each through `renderJsonNode()`. The
  empty-array case renders a short, distinct line (e.g. "Retried with the
  exact same arguments.") rather than nothing — silence here would read as
  "no diff was computed," which is the other, absent-field state.

- **The `app.test.js` fake-DOM harness gets extended, not worked around.**
  Its `FakeElement.querySelectorAll()`/`documentStub.querySelectorAll` are
  currently hardcoded to always return `[]`, so `renderSteps()`'s per-step
  click handlers — the normal way `pinStep(i)` gets invoked, which is what
  actually populates `#insp` with the `.io-sig` block, `diffs`, and would
  populate the new `argsDiff` block — can never fire through this harness
  today, and no existing test reaches pinned-step rendering at all. This
  phase makes `querySelectorAll` actually match elements (at minimum
  enough to find `.step` elements by class) so `pinStep` is reachable the
  same way a real browser reaches it, rather than inventing a
  phase-scoped workaround (e.g. reaching into `renderSignals()`'s real
  `document.createElement`-backed click listener) that leaves the
  underlying gap in place for the next phase that touches step-inspector
  rendering.

## What's left to the builder

- Exact CSS class names and layout for the new argsDiff rows (follow the
  file's existing naming convention, e.g. `argdiff-*`, sized and spaced to
  sit naturally under the existing `.io-sig` block — don't reuse
  `diff-add`/`diff-del`/`diff-hunk`/`diff-ctx`, which are unified-diff-line
  classes that don't apply to a key/value comparison).
- Exact copy for the "identical arguments" empty-array case and for
  labeling which value is "before" vs "after" in the UI.
- Whether `buildArgsDiff` lives as a standalone function near
  `detectRetries()` or as a nested closure — whichever reads more clearly
  given the final diff of `detectRetries()`'s loop body.
- Full test case list for both `runs.test.js` (diff-building correctness:
  identical objects, added/removed/changed keys, one or both sides
  non-object, one or both sides missing the `"Input"` entry entirely) and
  `app.test.js` (rendering: present-with-entries, present-empty, and
  absent cases all producing visibly different output).
