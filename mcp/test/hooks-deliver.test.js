import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { traceIdFromSessionId, buildAttachmentSpan, deliverBestEffort } from "../dist/hooks/deliver.js";

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

	test("multiple entries against an unreachable endpoint complete in ~one timeout budget, not N timeout budgets", async () => {
		// Regression guard: a sequential dispatch loop would cost
		// entries.length * timeoutMs against an unreachable server (here,
		// 5 * 500ms = 2500ms); concurrent dispatch must cost ~timeoutMs
		// regardless of entry count.
		const entries = Array.from({ length: 5 }, (_, i) => ({
			source: "pre_tool_use_hook", kind: "tool_file", nameOrPath: `/a${i}.ts`,
			sizeBytes: 5, timestamp: "2026-11-09T00:00:00.000Z", sessionId: "s1",
		}));
		const start = Date.now();
		await assert.doesNotReject(() =>
			deliverBestEffort({ url: "http://10.255.255.1", environment: "default", serviceName: "test" }, entries, 500),
		);
		const elapsed = Date.now() - start;
		assert.ok(elapsed < 1500, `expected ~one timeout budget (500ms) regardless of entry count, took ${elapsed}ms`);
	});
});
