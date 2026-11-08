import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { fromPreToolUse, fromUserPromptExpansion, fromTranscriptAttachment } from "../dist/hooks/capture.js";

describe("fromPreToolUse", () => {
	test("Read produces a tool_file entry with the absolute file path", () => {
		const entries = fromPreToolUse({ tool_name: "Read", tool_input: { file_path: "/a/b/c.ts" }, session_id: "s1" });
		assert.equal(entries.length, 1);
		assert.equal(entries[0].kind, "tool_file");
		assert.equal(entries[0].nameOrPath, "/a/b/c.ts");
		assert.equal(entries[0].source, "pre_tool_use_hook");
		assert.equal(entries[0].sessionId, "s1");
	});

	test("Bash produces no entry", () => {
		assert.deepEqual(fromPreToolUse({ tool_name: "Bash", tool_input: { command: "ls" } }), []);
	});

	test("Skill produces a skill entry", () => {
		const entries = fromPreToolUse({ tool_name: "Skill", tool_input: { name: "brainstorming" } });
		assert.equal(entries[0].kind, "skill");
		assert.equal(entries[0].nameOrPath, "brainstorming");
	});

	test("Skill falls back to a sanitized, stringified tool_input when no name/skill field is present", () => {
		const secret = "sk-abcdefghij1234567890";
		const entries = fromPreToolUse({ tool_name: "Skill", tool_input: { apiKey: secret } });
		assert.equal(entries[0].kind, "skill");
		assert.ok(!entries[0].nameOrPath.includes(secret), "secret-shaped value should be redacted");
	});

	test("an mcp__ tool produces an mcp_server entry", () => {
		const entries = fromPreToolUse({ tool_name: "mcp__trail__trail_log_step", tool_input: {},
			mcp_server: { name: "trail", source: "project" } });
		assert.equal(entries[0].kind, "mcp_server");
		assert.equal(entries[0].nameOrPath, "trail");
	});

	test("missing or non-string session_id falls back to an empty string", () => {
		const entries = fromPreToolUse({ tool_name: "Read", tool_input: { file_path: "/a.ts" } });
		assert.equal(entries[0].sessionId, "");
		const entries2 = fromPreToolUse({ tool_name: "Read", tool_input: { file_path: "/a.ts" }, session_id: 123 });
		assert.equal(entries2[0].sessionId, "");
	});
});

describe("fromUserPromptExpansion", () => {
	test("a slash command produces a skill entry", () => {
		const entries = fromUserPromptExpansion({ command_name: "brainstorming", expansion_type: "slash_command", session_id: "s1" });
		assert.equal(entries[0].kind, "skill");
		assert.equal(entries[0].nameOrPath, "brainstorming");
		assert.equal(entries[0].sessionId, "s1");
	});

	test("an mcp_prompt expansion produces an mcp_server entry", () => {
		const entries = fromUserPromptExpansion({ command_name: "notion-fetch", expansion_type: "mcp_prompt" });
		assert.equal(entries[0].kind, "mcp_server");
		assert.equal(entries[0].sessionId, "");
	});
});

describe("fromTranscriptAttachment", () => {
	test("extracts additionalContext from Claude-Code-shaped stdout", () => {
		const entry = fromTranscriptAttachment({
			hookEvent: "SessionStart", hookName: "SessionStart:startup",
			stdout: JSON.stringify({ hookSpecificOutput: { additionalContext: "you have superpowers" } }),
			command: "c", exitCode: 0, durationMs: 1, timestamp: "2026-11-09T00:00:00.000Z",
		}, "s1");
		assert.equal(entry.source, "transcript_hook_attachment");
		assert.equal(entry.kind, "hook_injected_context");
		assert.equal(entry.contentPreview, "you have superpowers");
		assert.equal(entry.sizeBytes, Buffer.byteLength("you have superpowers", "utf8"));
		assert.equal(entry.sessionId, "s1");
	});

	test("truncates oversized content via sanitize() while sizeBytes keeps the original length", () => {
		const big = "x".repeat(20000);
		const entry = fromTranscriptAttachment({
			hookEvent: "SessionStart", hookName: "SessionStart:startup",
			stdout: JSON.stringify({ hookSpecificOutput: { additionalContext: big } }),
			command: "c", exitCode: 0, durationMs: 1, timestamp: "t",
		}, "s1");
		assert.equal(entry.sizeBytes, 20000);
		assert.ok(entry.contentPreview.length < 20000);
	});

	test("falls back to the raw stdout string when it isn't the expected shape", () => {
		const entry = fromTranscriptAttachment({
			hookEvent: "PreToolUse", hookName: "PreToolUse", stdout: "not json",
			command: "c", exitCode: 0, durationMs: 1, timestamp: "t",
		}, "s1");
		assert.equal(entry.contentPreview, "not json");
	});

	test("caller-supplied sessionId is used as-is, since the transcript record itself has none", () => {
		const entry = fromTranscriptAttachment({
			hookEvent: "SessionStart", hookName: "SessionStart:startup", stdout: "x",
			command: "c", exitCode: 0, durationMs: 1, timestamp: "t",
		}, "session-xyz");
		assert.equal(entry.sessionId, "session-xyz");
	});
});
