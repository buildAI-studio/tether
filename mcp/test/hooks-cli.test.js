import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, cpSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { runHook } from "../dist/hooks/run.js";
import { COMPOSITION_LOG_FILENAME, COMPOSITION_OFFSET_FILENAME } from "../dist/hooks/log.js";

describe("runHook", () => {
	test("a pre-tool-use Read call produces one tool_file entry in the log", async () => {
		const dir = mkdtempSync(join(tmpdir(), "trail-run-"));
		const payload = JSON.stringify({ scratchpad_dir: dir, session_id: "s1", tool_name: "Read", tool_input: { file_path: "/a.ts" } });
		await runHook("pre-tool-use", payload);
		const lines = readFileSync(join(dir, COMPOSITION_LOG_FILENAME), "utf8").trim().split("\n");
		assert.equal(lines.length, 1);
		assert.equal(JSON.parse(lines[0]).nameOrPath, "/a.ts");
		assert.equal(JSON.parse(lines[0]).sessionId, "s1");
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
		const payload = JSON.stringify({ scratchpad_dir: dir, session_id: "s1", transcript_path: transcriptPath, tool_name: "Bash", tool_input: {} });
		await runHook("pre-tool-use", payload);
		await runHook("pre-tool-use", payload); // same transcript, no new lines appended to it
		const lines = readFileSync(join(dir, COMPOSITION_LOG_FILENAME), "utf8").trim().split("\n");
		assert.equal(lines.length, 1);
		assert.equal(JSON.parse(lines[0]).source, "transcript_hook_attachment");
		assert.equal(JSON.parse(lines[0]).sessionId, "s1");
	});

	test("two sessions sharing a log dir (cwd fallback) with the same transcript don't reset each other's offset", async () => {
		const dir = mkdtempSync(join(tmpdir(), "trail-run-"));
		const transcriptPath = join(dir, "transcript.jsonl");
		const attachmentLine = (text) => JSON.stringify({ type: "attachment", timestamp: "t", attachment: {
			type: "hook_success", hookEvent: "SessionStart", hookName: "SessionStart:startup",
			stdout: JSON.stringify({ hookSpecificOutput: { additionalContext: text } }),
			command: "c", exitCode: 0, durationMs: 1,
		} }) + "\n";
		writeFileSync(transcriptPath, attachmentLine("first"));

		const payloadFor = (sessionId) => JSON.stringify({ cwd: dir, session_id: sessionId, transcript_path: transcriptPath, tool_name: "Bash", tool_input: {} });

		// Session 1 reads the first attachment and advances its own offset.
		await runHook("pre-tool-use", payloadFor("session-1"));
		// Session 2 firing against the same shared transcript must not reset session 1's offset to 0.
		await runHook("pre-tool-use", payloadFor("session-2"));

		// A new line is appended; only session 1 should pick it up (session 2 already "caught up" to it as well,
		// since both start from the same transcript -- what matters is neither clobbers the other's recorded offset).
		writeFileSync(transcriptPath, readFileSync(transcriptPath, "utf8") + attachmentLine("second"));
		await runHook("pre-tool-use", payloadFor("session-1"));

		const lines = readFileSync(join(dir, COMPOSITION_LOG_FILENAME), "utf8").trim().split("\n").map((l) => JSON.parse(l));
		// session-1, session-2, then session-1 again for the new line only (not a re-read of "first").
		assert.equal(lines.length, 3);
		assert.equal(lines[0].sessionId, "session-1");
		assert.equal(lines[1].sessionId, "session-2");
		assert.equal(lines[2].sessionId, "session-1");
		assert.equal(lines[2].contentPreview, "second");

		const offsetMap = JSON.parse(readFileSync(join(dir, COMPOSITION_OFFSET_FILENAME), "utf8"));
		assert.ok(offsetMap["session-1"]);
		assert.ok(offsetMap["session-2"]);
		assert.notEqual(offsetMap["session-1"].byteOffset, 0);
		assert.notEqual(offsetMap["session-2"].byteOffset, 0);
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

	test("survives a broken install where the server-only dependency (@modelcontextprotocol/sdk) is unresolvable: exits 0 with empty stdout and still appends to the log", () => {
		// Copy just dist/ into a fresh scratch directory with no node_modules
		// anywhere in its ancestry, reproducing a partial/corrupted install
		// (or any install where only the hook path's own files, not the full
		// MCP server stack, made it onto disk). Node's ESM resolver walks up
		// from the importing file's own directory looking for node_modules,
		// so @modelcontextprotocol/sdk is genuinely unresolvable here -- this
		// is not a mock, it's the actual failure mode. Finding 1 requires the
		// hook subcommand to never let that reach process.exit with a
		// non-zero code or any stdout, because PreToolUse's stdout is read by
		// Claude Code as live control data.
		const scratch = mkdtempSync(join(tmpdir(), "trail-broken-install-"));
		cpSync(new URL("../dist", import.meta.url).pathname, join(scratch, "dist"), { recursive: true });

		const payload = JSON.stringify({ scratchpad_dir: scratch, tool_name: "Read", tool_input: { file_path: "/y.ts" } });
		const result = execFileSync(process.execPath, [join(scratch, "dist", "index.js"), "hook", "pre-tool-use"], {
			input: payload, encoding: "utf8",
		});

		assert.equal(result, "");
		assert.ok(existsSync(join(scratch, COMPOSITION_LOG_FILENAME)), "the hook path itself must still have run and written its log");
	});

	test("runHook still writes the local log even when delivery is unreachable", () => {
		// TRAIL_URL points at a black-hole address (no RST, no ICMP
		// unreachable) rather than a fast-refused one, so this exercises
		// deliverBestEffort's own timeout racing sendSpan, not just a fetch
		// that fails instantly. The hook CLI subcommand must still exit 0
		// with empty stdout and the local JSONL log -- the durable source of
		// truth -- must still be written, within a bounded wall-clock time
		// (asserted via execFileSync's own `timeout`, which would throw if
		// the process hung instead of exiting via index.ts's process.exit(0)).
		const dir = mkdtempSync(join(tmpdir(), "trail-cli-unreachable-"));
		const payload = JSON.stringify({ scratchpad_dir: dir, session_id: "s1", tool_name: "Read", tool_input: { file_path: "/z.ts" } });
		const stdout = execFileSync(process.execPath, [new URL("../dist/index.js", import.meta.url).pathname, "hook", "pre-tool-use"], {
			input: payload,
			encoding: "utf8",
			timeout: 15000,
			env: { ...process.env, TRAIL_URL: "http://10.255.255.1" },
		});
		assert.equal(stdout, "");
		const lines = readFileSync(join(dir, COMPOSITION_LOG_FILENAME), "utf8").trim().split("\n");
		assert.equal(lines.length, 1);
		assert.equal(JSON.parse(lines[0]).nameOrPath, "/z.ts");
	});
});
