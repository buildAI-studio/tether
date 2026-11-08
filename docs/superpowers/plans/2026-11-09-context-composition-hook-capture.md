# Context Composition Hook Capture — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `trailai-mcp hook <event>` subcommand that Claude Code invokes via its own hook contract, which — independent of whether the agent ever self-reports anything — writes a local, append-only record of (a) skills and files the agent actually touched, and (b) content silently injected into context by *any* hook (ours or a third party's, e.g. a plugin's `SessionStart` hook), to a local JSONL log.

**Architecture:** Three documented Claude Code hook events (`SessionStart`, `PreToolUse`, `UserPromptExpansion`, plus `Stop` as a final-flush safety net) each invoke the same CLI entry point. Two independent data sources feed one shared `AttachmentEntry` log: (1) each hook's own documented stdin fields (`tool_name`/`tool_input`, `command_name`/`command_args`) for what *that* hook directly observed, and (2) a forward scan of `transcript_path` — which Claude Code uses to log every hook invocation from any source as a `type:"attachment"` record — for what a *different* hook injected, which is otherwise unobservable. A session-scoped offset sidecar file makes repeated firings idempotent.

**Tech Stack:** TypeScript (existing `mcp/` package, Node ≥18, ESM, compiled via `tsc` to `dist/`), `node:test` for tests (run against compiled `dist/`, matching this package's existing convention).

**Spec:** `docs/superpowers/specs/2026-11-08-context-composition-visibility-design.md` — this plan implements §1 ("Hook-based silent-attachment capture") and §3's `AttachmentEntry` schema only. §2 (delivery to Tether's server), §3's UI, §5 (reachability/Trail), and server-side composition API are explicitly out of scope for this plan (see Global Constraints).

## Global Constraints

- The hook process must **never write to stdout** and must **always exit 0**, regardless of success or failure internally — `PreToolUse`'s JSON output channel can set `permissionDecision`/rewrite tool output, and `SessionStart`'s plain stdout is itself read as injected context, so any accidental output changes the agent's own behavior (spec §1).
- All captured string content goes through the existing `sanitize()` (`mcp/src/sanitize.ts`, 16KB-per-string-leaf truncation + secret redaction) before it's written anywhere. Do not add a second redaction mechanism.
- No network calls from the hook path in this plan. Local JSONL only — best-effort live delivery to `TRAIL_URL` is explicitly deferred to a later plan (spec §2's "live, best-effort" path), not built here.
- v1 is Claude-Code-only. Do not add Cursor/Windsurf-specific branching.
- Parse `transcript_path` defensively: it is Claude Code's internal, unversioned log format, not a published contract. A line that doesn't match the expected shape is skipped, never thrown.
- Node ≥18, ESM (`"type": "module"`), relative imports use explicit `.js` extensions (matches every existing file in `mcp/src/`).
- Tests import from compiled `../dist/*.js` and run via `node --test test/*.js`, matching every existing test in `mcp/test/`.

## Review Focus

- A `transcript_path` line split mid-write (hook fires while Claude Code is still flushing) must not crash the scan and must not advance the offset past the incomplete line — Task 1.
- `scratchpad_dir` absent from hook stdin (Claude Code < 2.1.257) must fall back to `cwd` rather than failing to resolve a log location — Task 3.
- Hook stdin that isn't valid JSON at all (a corrupted or empty pipe) must be swallowed silently — no throw, no stdout, still exit 0 — Task 4.
- Oversized injected content (the original real-world trigger for this whole feature: a multi-KB `SessionStart` `additionalContext` blob) must be truncated to 16KB via `sanitize()` in `contentPreview`, while `sizeBytes` still reflects the untruncated original — Task 2.
- Repeated hook firings against the same transcript within one session (`PreToolUse` fires on every tool call) must not reprocess or duplicate previously-captured `transcript_hook_attachment` entries — Task 1 (offset advances monotonically) and Task 4 (end-to-end idempotency check).

---

## Task 1: Transcript scanning

**Files:**
- Create: `mcp/src/hooks/transcript.ts`
- Test: `mcp/test/hooks-transcript.test.js`

**Interfaces:**
- Produces:
  ```ts
  export interface TranscriptAttachment {
    hookEvent: string;
    hookName: string;
    stdout: string;
    command: string;
    exitCode: number;
    durationMs: number;
    timestamp: string;
  }
  export interface ScanResult {
    attachments: TranscriptAttachment[];
    newOffset: number;
  }
  export function scanTranscriptForAttachments(transcriptPath: string, fromByteOffset: number): ScanResult
  ```

`scanTranscriptForAttachments` reads `transcriptPath` as a `Buffer`, slices from `fromByteOffset` to the end, and splits that slice into lines. Every line except a possible trailing partial one (the file may not end in `\n` if still being written) is a "complete line." For each complete line: `JSON.parse` it; if parsing throws, or the parsed value isn't an object with `type === "attachment"` and an `attachment` object carrying string `hookEvent`/`hookName`/`stdout`/`command` and a numeric `exitCode`, skip that line — don't throw. For a line that does match, push a `TranscriptAttachment` built from `attachment.hookEvent`, `attachment.hookName`, `attachment.stdout`, `attachment.command`, `attachment.exitCode`, `attachment.durationMs`, and the record's own top-level `timestamp`. `newOffset` is `fromByteOffset` plus the byte length (UTF-8) of every complete line consumed, including its trailing `\n` — the incomplete trailing remainder (if any) is never counted, so the next call re-reads it once it's whole. A missing `transcriptPath` (file doesn't exist yet) returns `{ attachments: [], newOffset: fromByteOffset }`, not a throw.

- [ ] **Step 1: Write the failing tests**

```js
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { scanTranscriptForAttachments } from "../dist/hooks/transcript.js";

function tmpFile(content) {
  const dir = mkdtempSync(join(tmpdir(), "trail-transcript-"));
  const path = join(dir, "transcript.jsonl");
  writeFileSync(path, content, "utf8");
  return path;
}

describe("scanTranscriptForAttachments", () => {
  test("finds a hook_success attachment record from offset 0", () => {
    const line = JSON.stringify({
      type: "attachment",
      timestamp: "2026-11-09T00:00:00.000Z",
      attachment: { type: "hook_success", hookEvent: "SessionStart", hookName: "SessionStart:startup",
        stdout: "{\"hookSpecificOutput\":{\"additionalContext\":\"hi\"}}", command: "run-hook.cmd session-start",
        exitCode: 0, durationMs: 42 },
    }) + "\n";
    const path = tmpFile(line);
    const result = scanTranscriptForAttachments(path, 0);
    assert.equal(result.attachments.length, 1);
    assert.equal(result.attachments[0].hookEvent, "SessionStart");
    assert.equal(result.attachments[0].hookName, "SessionStart:startup");
    assert.equal(result.newOffset, Buffer.byteLength(line, "utf8"));
  });

  test("skips a non-attachment line without throwing", () => {
    const path = tmpFile(JSON.stringify({ type: "mode", mode: "normal" }) + "\n");
    const result = scanTranscriptForAttachments(path, 0);
    assert.deepEqual(result.attachments, []);
  });

  test("skips an unparseable line without throwing", () => {
    const path = tmpFile("{not json\n");
    const result = scanTranscriptForAttachments(path, 0);
    assert.deepEqual(result.attachments, []);
  });

  test("does not consume a trailing line with no newline yet", () => {
    const complete = JSON.stringify({ type: "attachment", timestamp: "t",
      attachment: { type: "hook_success", hookEvent: "PreToolUse", hookName: "PreToolUse",
        stdout: "", command: "c", exitCode: 0, durationMs: 1 } }) + "\n";
    const partial = '{"type":"attachment","attachm'; // mid-write, no trailing newline
    const path = tmpFile(complete + partial);
    const result = scanTranscriptForAttachments(path, 0);
    assert.equal(result.attachments.length, 1);
    assert.equal(result.newOffset, Buffer.byteLength(complete, "utf8"));
  });

  test("a second scan from the returned offset finds nothing new", () => {
    const line = JSON.stringify({ type: "attachment", timestamp: "t",
      attachment: { type: "hook_success", hookEvent: "PreToolUse", hookName: "PreToolUse",
        stdout: "", command: "c", exitCode: 0, durationMs: 1 } }) + "\n";
    const path = tmpFile(line);
    const first = scanTranscriptForAttachments(path, 0);
    const second = scanTranscriptForAttachments(path, first.newOffset);
    assert.deepEqual(second.attachments, []);
    assert.equal(second.newOffset, first.newOffset);
  });

  test("a missing transcript file returns no attachments and the same offset", () => {
    const result = scanTranscriptForAttachments("/nonexistent/path/transcript.jsonl", 7);
    assert.deepEqual(result.attachments, []);
    assert.equal(result.newOffset, 7);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd mcp && npm run build && node --test test/hooks-transcript.test.js`
Expected: FAIL (module `../dist/hooks/transcript.js` not found)

- [ ] **Step 3: Implement `scanTranscriptForAttachments` in `mcp/src/hooks/transcript.ts`**

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd mcp && npm run build && node --test test/hooks-transcript.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add mcp/src/hooks/transcript.ts mcp/test/hooks-transcript.test.js
git commit -m "feat(mcp): scan transcript_path for any hook's attachment records"
```

---

## Task 2: Attachment entry construction

**Files:**
- Create: `mcp/src/hooks/capture.ts`
- Test: `mcp/test/hooks-capture.test.js`

**Interfaces:**
- Consumes: `TranscriptAttachment` (Task 1); `sanitize(value: unknown, maxBytes?: number): unknown` from `mcp/src/sanitize.ts` (existing).
- Produces:
  ```ts
  export interface AttachmentEntry {
    source: "pre_tool_use_hook" | "user_prompt_expansion_hook" | "transcript_hook_attachment" | "self_reported";
    kind: "skill" | "memory_file" | "claude_md" | "tool_file" | "mcp_server" | "hook_injected_context";
    nameOrPath: string;
    sizeBytes: number;
    contentPreview?: string;
    timestamp: string;
  }
  export function fromPreToolUse(payload: Record<string, unknown>): AttachmentEntry[]
  export function fromUserPromptExpansion(payload: Record<string, unknown>): AttachmentEntry[]
  export function fromTranscriptAttachment(att: TranscriptAttachment): AttachmentEntry
  ```

`fromPreToolUse` reads `payload.tool_name` and `payload.tool_input`. It emits exactly one entry for `tool_name` in `{"Read", "Write", "Edit"}` (`kind: "tool_file"`, `nameOrPath: tool_input.file_path`, `sizeBytes: Buffer.byteLength(tool_input.file_path, "utf8")`, no `contentPreview`); one entry for `tool_name === "Skill"` (`kind: "skill"`, `nameOrPath`: `tool_input.name` if it's a string, else `tool_input.skill` if that's a string, else `JSON.stringify(tool_input)` as a last resort — the exact field Claude Code uses for the Skill tool's argument is unconfirmed per the spec's open "empirical confirmation" item, so try the plausible field names defensively rather than assuming one); one entry for an MCP tool name matching `/^mcp__/` (`kind: "mcp_server"`, `nameOrPath`: `payload.mcp_server` object's `name` field if present, else the part of `tool_name` between the first and second `__`). Any other `tool_name` (e.g. `Bash`, `Grep`, `WebFetch`) produces no entry — those aren't "skills or files attached," and self-reported structured tool-call data already covers them. `timestamp` is `new Date().toISOString()` (hook payloads don't carry one for `PreToolUse`).

`fromUserPromptExpansion` reads `payload.command_name`, `payload.command_args`, `payload.expansion_type`. `kind` is `"skill"` when `expansion_type === "slash_command"`, `"mcp_server"` otherwise. `nameOrPath` is `payload.command_name`. If `command_args` is present, `sizeBytes` is its stringified byte length and `contentPreview` is `sanitize(String(command_args))` (cast to string first if it's not already one); otherwise `sizeBytes` is 0 and `contentPreview` is omitted.

`fromTranscriptAttachment` always produces `source: "transcript_hook_attachment"`, `kind: "hook_injected_context"`, `nameOrPath: att.hookName`, `timestamp: att.timestamp`. It extracts the actual injected text from `att.stdout`: try `JSON.parse(att.stdout)` and read, in order, `.hookSpecificOutput?.additionalContext`, `.additional_context`, `.additionalContext`; if none is a string (parse failed, or none of those keys present), fall back to the raw `att.stdout` string itself. `sizeBytes` is that extracted string's untruncated UTF-8 byte length; `contentPreview` is `sanitize(extracted)` (default 16KB budget).

- [ ] **Step 1: Write the failing tests**

```js
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { fromPreToolUse, fromUserPromptExpansion, fromTranscriptAttachment } from "../dist/hooks/capture.js";

describe("fromPreToolUse", () => {
  test("Read produces a tool_file entry with the absolute file path", () => {
    const entries = fromPreToolUse({ tool_name: "Read", tool_input: { file_path: "/a/b/c.ts" } });
    assert.equal(entries.length, 1);
    assert.equal(entries[0].kind, "tool_file");
    assert.equal(entries[0].nameOrPath, "/a/b/c.ts");
    assert.equal(entries[0].source, "pre_tool_use_hook");
  });

  test("Bash produces no entry", () => {
    assert.deepEqual(fromPreToolUse({ tool_name: "Bash", tool_input: { command: "ls" } }), []);
  });

  test("Skill produces a skill entry", () => {
    const entries = fromPreToolUse({ tool_name: "Skill", tool_input: { name: "brainstorming" } });
    assert.equal(entries[0].kind, "skill");
    assert.equal(entries[0].nameOrPath, "brainstorming");
  });

  test("an mcp__ tool produces an mcp_server entry", () => {
    const entries = fromPreToolUse({ tool_name: "mcp__trail__trail_log_step", tool_input: {},
      mcp_server: { name: "trail", source: "project" } });
    assert.equal(entries[0].kind, "mcp_server");
    assert.equal(entries[0].nameOrPath, "trail");
  });
});

describe("fromUserPromptExpansion", () => {
  test("a slash command produces a skill entry", () => {
    const entries = fromUserPromptExpansion({ command_name: "brainstorming", expansion_type: "slash_command" });
    assert.equal(entries[0].kind, "skill");
    assert.equal(entries[0].nameOrPath, "brainstorming");
  });

  test("an mcp_prompt expansion produces an mcp_server entry", () => {
    const entries = fromUserPromptExpansion({ command_name: "notion-fetch", expansion_type: "mcp_prompt" });
    assert.equal(entries[0].kind, "mcp_server");
  });
});

describe("fromTranscriptAttachment", () => {
  test("extracts additionalContext from Claude-Code-shaped stdout", () => {
    const entry = fromTranscriptAttachment({
      hookEvent: "SessionStart", hookName: "SessionStart:startup",
      stdout: JSON.stringify({ hookSpecificOutput: { additionalContext: "you have superpowers" } }),
      command: "c", exitCode: 0, durationMs: 1, timestamp: "2026-11-09T00:00:00.000Z",
    });
    assert.equal(entry.source, "transcript_hook_attachment");
    assert.equal(entry.kind, "hook_injected_context");
    assert.equal(entry.contentPreview, "you have superpowers");
    assert.equal(entry.sizeBytes, Buffer.byteLength("you have superpowers", "utf8"));
  });

  test("truncates oversized content via sanitize() while sizeBytes keeps the original length", () => {
    const big = "x".repeat(20000);
    const entry = fromTranscriptAttachment({
      hookEvent: "SessionStart", hookName: "SessionStart:startup",
      stdout: JSON.stringify({ hookSpecificOutput: { additionalContext: big } }),
      command: "c", exitCode: 0, durationMs: 1, timestamp: "t",
    });
    assert.equal(entry.sizeBytes, 20000);
    assert.ok(entry.contentPreview.length < 20000);
  });

  test("falls back to the raw stdout string when it isn't the expected shape", () => {
    const entry = fromTranscriptAttachment({
      hookEvent: "PreToolUse", hookName: "PreToolUse", stdout: "not json",
      command: "c", exitCode: 0, durationMs: 1, timestamp: "t",
    });
    assert.equal(entry.contentPreview, "not json");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd mcp && npm run build && node --test test/hooks-capture.test.js`
Expected: FAIL (module not found)

- [ ] **Step 3: Implement `fromPreToolUse`, `fromUserPromptExpansion`, `fromTranscriptAttachment` in `mcp/src/hooks/capture.ts`**

Import `sanitize` from `../sanitize.js`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd mcp && npm run build && node --test test/hooks-capture.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add mcp/src/hooks/capture.ts mcp/test/hooks-capture.test.js
git commit -m "feat(mcp): build AttachmentEntry records from hook payloads"
```

---

## Task 3: Local log and offset persistence

**Files:**
- Create: `mcp/src/hooks/log.ts`
- Test: `mcp/test/hooks-log.test.js`

**Interfaces:**
- Consumes: `AttachmentEntry` (Task 2).
- Produces:
  ```ts
  export const COMPOSITION_LOG_FILENAME = "trail-composition.jsonl";
  export const COMPOSITION_OFFSET_FILENAME = "trail-composition.offset.json";
  export function resolveLogDir(payload: { scratchpad_dir?: unknown; cwd?: unknown }): string
  export function readOffset(logDir: string, transcriptPath: string): number
  export function writeOffset(logDir: string, transcriptPath: string, byteOffset: number): void
  export function appendEntries(logDir: string, entries: AttachmentEntry[]): void
  ```

`resolveLogDir` returns `payload.scratchpad_dir` if it's a non-empty string, else `payload.cwd` if it's a non-empty string, else `process.cwd()`.

`readOffset` reads `<logDir>/<COMPOSITION_OFFSET_FILENAME>`, JSON-parses it as `{ transcriptPath: string; byteOffset: number }`. Returns `0` if the file doesn't exist, fails to parse, or its `transcriptPath` doesn't match the one passed in (a changed transcript path means start over, don't miscount into the wrong file — matches `manifest.ts`'s existing convention of catching `readFileSync`/`statSync` errors and falling back to a safe default rather than throwing).

`writeOffset` writes `{ transcriptPath, byteOffset }` as JSON to that same path, creating `logDir` first if needed (`mkdirSync(logDir, { recursive: true })`).

`appendEntries` appends each entry as one JSON line to `<logDir>/<COMPOSITION_LOG_FILENAME>` (creating the directory if needed), using `appendFileSync` so concurrent hook invocations each add their own lines rather than clobbering the file.

- [ ] **Step 1: Write the failing tests**

```js
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  resolveLogDir, readOffset, writeOffset, appendEntries,
  COMPOSITION_LOG_FILENAME, COMPOSITION_OFFSET_FILENAME,
} from "../dist/hooks/log.js";

describe("resolveLogDir", () => {
  test("prefers scratchpad_dir when present", () => {
    assert.equal(resolveLogDir({ scratchpad_dir: "/s", cwd: "/c" }), "/s");
  });
  test("falls back to cwd when scratchpad_dir is absent", () => {
    assert.equal(resolveLogDir({ cwd: "/c" }), "/c");
  });
  test("falls back to process.cwd() when neither is present", () => {
    assert.equal(resolveLogDir({}), process.cwd());
  });
});

describe("offset persistence", () => {
  test("readOffset returns 0 when no offset file exists yet", () => {
    const dir = mkdtempSync(join(tmpdir(), "trail-log-"));
    assert.equal(readOffset(dir, "/t.jsonl"), 0);
  });

  test("writeOffset then readOffset round-trips for the same transcript path", () => {
    const dir = mkdtempSync(join(tmpdir(), "trail-log-"));
    writeOffset(dir, "/t.jsonl", 123);
    assert.equal(readOffset(dir, "/t.jsonl"), 123);
  });

  test("readOffset resets to 0 if the transcript path has changed", () => {
    const dir = mkdtempSync(join(tmpdir(), "trail-log-"));
    writeOffset(dir, "/t-old.jsonl", 999);
    assert.equal(readOffset(dir, "/t-new.jsonl"), 0);
  });
});

describe("appendEntries", () => {
  test("appends one JSON line per entry, creating the directory if needed", () => {
    const dir = join(mkdtempSync(join(tmpdir(), "trail-log-")), "nested");
    const entry = { source: "pre_tool_use_hook", kind: "tool_file", nameOrPath: "/a.ts",
      sizeBytes: 4, timestamp: "t" };
    appendEntries(dir, [entry]);
    appendEntries(dir, [entry]);
    const lines = readFileSync(join(dir, COMPOSITION_LOG_FILENAME), "utf8").trim().split("\n");
    assert.equal(lines.length, 2);
    assert.deepEqual(JSON.parse(lines[0]), entry);
  });

  test("writing zero entries creates no file", () => {
    const dir = mkdtempSync(join(tmpdir(), "trail-log-"));
    appendEntries(dir, []);
    assert.equal(existsSync(join(dir, COMPOSITION_LOG_FILENAME)), false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd mcp && npm run build && node --test test/hooks-log.test.js`
Expected: FAIL (module not found)

- [ ] **Step 3: Implement `resolveLogDir`, `readOffset`, `writeOffset`, `appendEntries` in `mcp/src/hooks/log.ts`**

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd mcp && npm run build && node --test test/hooks-log.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add mcp/src/hooks/log.ts mcp/test/hooks-log.test.js
git commit -m "feat(mcp): persist composition entries and a transcript-scan offset"
```

---

## Task 4: CLI orchestration and dispatch

**Files:**
- Create: `mcp/src/hooks/run.ts`
- Create: `mcp/src/hooks/cli.ts`
- Modify: `mcp/src/index.ts` (add dispatch before the existing server startup)
- Test: `mcp/test/hooks-cli.test.js`

**Interfaces:**
- Consumes: everything from Tasks 1–3 (`scanTranscriptForAttachments`, `fromPreToolUse`, `fromUserPromptExpansion`, `fromTranscriptAttachment`, `resolveLogDir`, `readOffset`, `writeOffset`, `appendEntries`).
- Produces:
  ```ts
  export async function runHook(eventArg: string, stdinText: string): Promise<void>
  export async function main(argv: string[]): Promise<void>
  ```

`runHook` never throws. Internally: parse `stdinText` as JSON; if that fails, return immediately (nothing to do). Otherwise: build direct-field entries by calling `fromPreToolUse(payload)` when `eventArg === "pre-tool-use"`, `fromUserPromptExpansion(payload)` when `eventArg === "user-prompt-expansion"`, or `[]` for `session-start`/`stop`. Separately, if `payload.transcript_path` is a string: `resolveLogDir(payload)`, `readOffset(logDir, payload.transcript_path)`, `scanTranscriptForAttachments(payload.transcript_path, offset)`, map each resulting `TranscriptAttachment` through `fromTranscriptAttachment`, then `writeOffset(logDir, payload.transcript_path, scanResult.newOffset)`. Concatenate the direct-field entries and the transcript-derived entries and pass the combined array to `appendEntries(logDir, entries)`. Wrap the whole body in `try { ... } catch { /* never throw */ }`.

`main(argv)` reads all of `process.stdin` to a string (`for await (const chunk of process.stdin)`), calls `runHook(argv[0], stdinText)`, and returns — it does not call `process.exit` itself (the caller in `index.ts` does, so this function stays testable without killing the test process).

In `mcp/src/index.ts`, before the existing `buildTrailServer`/`StdioServerTransport` code, add:
```ts
if (process.argv[2] === "hook") {
  const { main } = await import("./hooks/cli.js");
  await main(process.argv.slice(3));
  process.exit(0);
}
```
This mirrors `server/src/index.ts:35-36`'s existing `if (process.argv[2] === "plugin")` subcommand dispatch, so a user registers `npx trailai-mcp hook pre-tool-use` etc. as the hook's `command` in `.claude/settings.json`.

- [ ] **Step 1: Write the failing tests**

```js
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { runHook } from "../dist/hooks/run.js";
import { COMPOSITION_LOG_FILENAME } from "../dist/hooks/log.js";

describe("runHook", () => {
  test("a pre-tool-use Read call produces one tool_file entry in the log", async () => {
    const dir = mkdtempSync(join(tmpdir(), "trail-run-"));
    const payload = JSON.stringify({ scratchpad_dir: dir, tool_name: "Read", tool_input: { file_path: "/a.ts" } });
    await runHook("pre-tool-use", payload);
    const lines = readFileSync(join(dir, COMPOSITION_LOG_FILENAME), "utf8").trim().split("\n");
    assert.equal(lines.length, 1);
    assert.equal(JSON.parse(lines[0]).nameOrPath, "/a.ts");
  });

  test("malformed stdin JSON writes nothing and does not throw", async () => {
    const dir = mkdtempSync(join(tmpdir(), "trail-run-"));
    await assert.doesNotReject(() => runHook("pre-tool-use", "{not json"));
    assert.equal(existsSync(join(dir, COMPOSITION_LOG_FILENAME)), false);
  });

  test("a transcript with another hook's attachment record contributes an entry, and a repeat call does not duplicate it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "trail-run-"));
    const transcriptPath = join(dir, "transcript.jsonl");
    const line = JSON.stringify({ type: "attachment", timestamp: "t", attachment: {
      type: "hook_success", hookEvent: "SessionStart", hookName: "SessionStart:startup",
      stdout: JSON.stringify({ hookSpecificOutput: { additionalContext: "injected text" } }),
      command: "c", exitCode: 0, durationMs: 1,
    } }) + "\n";
    writeFileSync(transcriptPath, line);
    const payload = JSON.stringify({ scratchpad_dir: dir, transcript_path: transcriptPath, tool_name: "Bash", tool_input: {} });
    await runHook("pre-tool-use", payload);
    await runHook("pre-tool-use", payload); // same transcript, no new lines appended to it
    const lines = readFileSync(join(dir, COMPOSITION_LOG_FILENAME), "utf8").trim().split("\n");
    assert.equal(lines.length, 1);
    assert.equal(JSON.parse(lines[0]).source, "transcript_hook_attachment");
  });
});

describe("the hook CLI subcommand (end-to-end)", () => {
  test("writes nothing to stdout, exits 0, and appends to the log", () => {
    const dir = mkdtempSync(join(tmpdir(), "trail-cli-"));
    const payload = JSON.stringify({ scratchpad_dir: dir, tool_name: "Read", tool_input: { file_path: "/x.ts" } });
    const stdout = execFileSync(process.execPath, [new URL("../dist/index.js", import.meta.url).pathname, "hook", "pre-tool-use"], {
      input: payload, encoding: "utf8",
    });
    assert.equal(stdout, "");
    assert.ok(existsSync(join(dir, COMPOSITION_LOG_FILENAME)));
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd mcp && npm run build && node --test test/hooks-cli.test.js`
Expected: FAIL (modules not found)

- [ ] **Step 3: Implement `runHook` in `mcp/src/hooks/run.ts` and `main` in `mcp/src/hooks/cli.ts`; add the dispatch block to `mcp/src/index.ts`**

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd mcp && npm run build && node --test test/hooks-cli.test.js`
Expected: PASS

- [ ] **Step 5: Run the full mcp test suite to confirm no regressions**

Run: `cd mcp && npm test`
Expected: all suites pass (existing suites plus the four new ones)

- [ ] **Step 6: Commit**

```bash
git add mcp/src/hooks/run.ts mcp/src/hooks/cli.ts mcp/src/index.ts mcp/test/hooks-cli.test.js
git commit -m "feat(mcp): wire up \`trailai-mcp hook <event>\` subcommand"
```

---

## Task 5: Documentation and version bump

**Files:**
- Modify: `mcp/README.md`
- Modify: `mcp/package.json`

**Interfaces:**
- Consumes: nothing new — documents Tasks 1–4's shipped behavior.

- [ ] **Step 1: Add a "Composition capture (hooks)" section to `mcp/README.md`**

Document: what it captures (skills/files actually touched, plus content any hook silently injects, regardless of self-reporting) and why (background/cloud sessions can't be watched live); the three events to register (`SessionStart`, `PreToolUse`, `UserPromptExpansion`, plus `Stop`) with a copy-pasteable `.claude/settings.json` hooks snippet, each `command` reading `npx trailai-mcp hook <event-name>` (`session-start` / `pre-tool-use` / `user-prompt-expansion` / `stop`); where the output lands (`trail-composition.jsonl` in the session's `scratchpad_dir`, or `cwd` on older Claude Code versions); that it's local-only in this version — no network delivery yet; and the same sanitize()/truncation guarantee already documented for diffs.

- [ ] **Step 2: Bump `mcp/package.json` version from `0.4.0` to `0.5.0`**

A new, backward-compatible capability (no existing tool schema changes) — matches this package's established pre-1.0 convention of a minor bump per shipped feature (e.g. `0.3.0` → `0.4.0` for agent-reported file diffs).

- [ ] **Step 3: Commit**

```bash
git add mcp/README.md mcp/package.json
git commit -m "docs(mcp): document the composition-capture hook subcommand; bump to 0.5.0"
```
