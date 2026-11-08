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
