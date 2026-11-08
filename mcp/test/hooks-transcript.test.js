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
