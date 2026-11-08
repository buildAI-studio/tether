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
