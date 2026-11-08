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
