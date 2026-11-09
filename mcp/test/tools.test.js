import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildStepSpan, buildLlmCallSpan, buildExceptionSpan, buildTrailServer } from "../dist/tools.js";

const RUN = { traceId: "t".repeat(32), rootSpanId: "r".repeat(16), agent: "coding-agent" };

// trail_finish_run builds its root span's attributes inline (no pure builder
// function to call directly), so to inspect what it sends we run it through
// a real McpServer <-> Client pair over an in-memory transport and stub
// global.fetch to capture the OTLP payload sendSpan posts.
async function finishRunAndCaptureSpanAttributes() {
	const originalFetch = global.fetch;
	let capturedBody;
	global.fetch = async (_url, opts) => {
		capturedBody = JSON.parse(opts.body);
		return { ok: true, text: async () => "" };
	};
	try {
		const cfg = { url: "http://localhost:4319", environment: "test", serviceName: "test" };
		const server = buildTrailServer(cfg, undefined);
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: "test-client", version: "1.0.0" });
		await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

		const startResult = await client.callTool({ name: "trail_start_run", arguments: { name: "test run" } });
		const runId = startResult.content[0].text.match(/run_id=(\w+)/)[1];
		await client.callTool({ name: "trail_finish_run", arguments: { run_id: runId, status: "ok" } });

		const span = capturedBody.resourceSpans[0].scopeSpans[0].spans[0];
		return Object.fromEntries(span.attributes.map((a) => [a.key, a.value]));
	} finally {
		global.fetch = originalFetch;
	}
}

describe("buildStepSpan", () => {
	test("sets gen_ai.tool.name and JSON-encodes string prompt/completion events for a successful tool step", () => {
		const span = buildStepSpan(RUN, "s1", "1000000000", "2000000000", {
			name: "run pytest", kind: "tool", input: "pytest -x", output: "1 failed", status: "ok",
		});
		assert.equal(span.attributes["gen_ai.tool.name"], "run pytest");
		assert.deepEqual(span.events, [
			{ name: "gen_ai.content.prompt", attributes: { "gen_ai.prompt": JSON.stringify("pytest -x") } },
			{ name: "gen_ai.content.completion", attributes: { "gen_ai.completion": JSON.stringify("1 failed") } },
		]);
		assert.equal(span.error, undefined);
	});

	test("structured object input/output are JSON-encoded into the prompt/completion events", () => {
		const span = buildStepSpan(RUN, "s8", "1000000000", "2000000000", {
			name: "edit auth.py", kind: "tool", status: "ok",
			input: { file: "auth.py", find: "old", replace: "new" },
			output: { ok: true, linesChanged: 3 },
		});
		assert.deepEqual(span.events, [
			{ name: "gen_ai.content.prompt", attributes: { "gen_ai.prompt": JSON.stringify({ file: "auth.py", find: "old", replace: "new" }) } },
			{ name: "gen_ai.content.completion", attributes: { "gen_ai.completion": JSON.stringify({ ok: true, linesChanged: 3 }) } },
		]);
	});

	test("a secret-shaped string inside a structured input is redacted before encoding", () => {
		const span = buildStepSpan(RUN, "s9", "1000000000", "2000000000", {
			name: "call api", kind: "tool", status: "ok",
			input: { headers: { Authorization: "Bearer abcxyz1234567890" } },
		});
		const decoded = JSON.parse(span.events[0].attributes["gen_ai.prompt"]);
		assert.equal(decoded.headers.Authorization, "[REDACTED]");
	});

	test("falsy-but-present values (0, false, empty string) still produce an event, not get dropped", () => {
		const span = buildStepSpan(RUN, "s10", "1000000000", "2000000000", { name: "check exit code", kind: "tool", status: "ok", output: 0 });
		assert.deepEqual(span.events, [{ name: "gen_ai.content.completion", attributes: { "gen_ai.completion": "0" } }]);
	});

	test("absent input/output produces no io events", () => {
		const span = buildStepSpan(RUN, "s11", "1000000000", "2000000000", { name: "plan", kind: "task", status: "ok" });
		assert.deepEqual(span.events, []);
	});

	test("omits gen_ai.tool.name for a task step", () => {
		const span = buildStepSpan(RUN, "s1", "1000000000", "2000000000", { name: "plan the fix", kind: "task", status: "ok" });
		assert.equal("gen_ai.tool.name" in span.attributes, false);
	});

	test("sets error.message on a failed step, defaulting when error_message is absent", () => {
		const span = buildStepSpan(RUN, "s2", "1000000000", "2000000000", { name: "run pytest", kind: "tool", status: "error" });
		assert.deepEqual(span.error, { message: "step failed" });
	});

	test("attributes source_type/source_name only when both are present", () => {
		const span = buildStepSpan(RUN, "s3", "1000000000", "2000000000", {
			name: "read auth.py", kind: "tool", status: "ok", source_type: "skill", source_name: "code-review",
		});
		assert.equal(span.attributes["gen_ai.harness.source_type"], "skill");
		assert.equal(span.attributes["gen_ai.harness.source_name"], "code-review");
	});
});

describe("buildLlmCallSpan", () => {
	test("computes total_tokens from input+output tokens and names the span 'chat {model}'", () => {
		const span = buildLlmCallSpan(RUN, "s4", "1000000000", "2000000000", {
			model: "claude-sonnet-4-5", input_tokens: 100, output_tokens: 50, status: "ok",
		});
		assert.equal(span.attributes["gen_ai.usage.total_tokens"], 150);
		assert.equal(span.name, "chat claude-sonnet-4-5");
	});

	test("leaves total_tokens undefined when neither input_tokens nor output_tokens is given", () => {
		const span = buildLlmCallSpan(RUN, "s5", "1000000000", "2000000000", { model: "gpt-4o-mini", status: "ok" });
		assert.equal(span.attributes["gen_ai.usage.total_tokens"], undefined);
	});

	test("JSON-encodes a messages array into the prompt event", () => {
		const messages = [{ role: "system", content: "be helpful" }, { role: "user", content: "fix the bug" }];
		const span = buildLlmCallSpan(RUN, "s12", "1000000000", "2000000000", { model: "gpt-4o-mini", messages, status: "ok" });
		assert.deepEqual(span.events, [{ name: "gen_ai.content.prompt", attributes: { "gen_ai.prompt": JSON.stringify(messages) } }]);
	});

	test("JSON-encodes the completion message object into the completion event", () => {
		const completion = { role: "assistant", content: "done" };
		const span = buildLlmCallSpan(RUN, "s13", "1000000000", "2000000000", { model: "gpt-4o-mini", completion, status: "ok" });
		assert.deepEqual(span.events, [{ name: "gen_ai.content.completion", attributes: { "gen_ai.completion": JSON.stringify(completion) } }]);
	});

	test("preserves tool_calls on the completion message", () => {
		const completion = { role: "assistant", content: "", tool_calls: [{ name: "read_file", args: { path: "a.py" } }] };
		const span = buildLlmCallSpan(RUN, "s14", "1000000000", "2000000000", { model: "gpt-4o-mini", completion, status: "ok" });
		assert.deepEqual(JSON.parse(span.events[0].attributes["gen_ai.completion"]), completion);
	});

	test("redacts a secret-shaped string inside a message's content", () => {
		const messages = [{ role: "user", content: "my key is sk-abcdefghij1234567890" }];
		const span = buildLlmCallSpan(RUN, "s15", "1000000000", "2000000000", { model: "gpt-4o-mini", messages, status: "ok" });
		const decoded = JSON.parse(span.events[0].attributes["gen_ai.prompt"]);
		assert.equal(decoded[0].content, "my key is [REDACTED]");
	});

	test("an empty messages array produces no prompt event", () => {
		const span = buildLlmCallSpan(RUN, "s16", "1000000000", "2000000000", { model: "gpt-4o-mini", messages: [], status: "ok" });
		assert.deepEqual(span.events, []);
	});
});

describe("buildExceptionSpan", () => {
	test("sets error message/type and defaults the span name to 'exception'", () => {
		const span = buildExceptionSpan(RUN, "s6", "2000000000", { message: "boom", type: "BuildError" });
		assert.equal(span.name, "exception");
		assert.deepEqual(span.error, { message: "boom", type: "BuildError" });
	});

	test("uses the given name when provided", () => {
		const span = buildExceptionSpan(RUN, "s7", "2000000000", { message: "boom", name: "test-failure" });
		assert.equal(span.name, "test-failure");
	});

	test("passes stack through to error.stack", () => {
		const span = buildExceptionSpan(RUN, "s17", "2000000000", { message: "boom", stack: "Error: boom\n  at build.js:1:1" });
		assert.equal(span.error.stack, "Error: boom\n  at build.js:1:1");
	});

	test("JSON-encodes context into a gen_ai.content.context event", () => {
		const span = buildExceptionSpan(RUN, "s18", "2000000000", { message: "boom", context: { attempt: 3, file: "auth.py" } });
		assert.deepEqual(span.events, [{ name: "gen_ai.content.context", attributes: { "gen_ai.context": JSON.stringify({ attempt: 3, file: "auth.py" }) } }]);
	});

	test("redacts a secret-shaped string inside context", () => {
		const span = buildExceptionSpan(RUN, "s19", "2000000000", { message: "boom", context: { env: "AKIAABCDEFGHIJKLMNOP" } });
		const decoded = JSON.parse(span.events[0].attributes["gen_ai.context"]);
		assert.equal(decoded.env, "[REDACTED]");
	});

	test("no context produces no events", () => {
		const span = buildExceptionSpan(RUN, "s20", "2000000000", { message: "boom" });
		assert.deepEqual(span.events, []);
	});
});

describe("buildStepSpan — diffs", () => {
	const base = { name: "edit auth.py", kind: "tool", status: "ok" };

	test("emits a gen_ai.content.diffs event carrying sanitized entries", () => {
		const span = buildStepSpan(RUN, "s1", "1000", "2000", {
			...base,
			diffs: [{ path: "auth.py", diff: "--- a/auth.py\n+++ b/auth.py\n@@ -1 +1 @@\n-a\n+b\n" }],
		});
		const ev = span.events.find((e) => e.name === "gen_ai.content.diffs");
		assert.ok(ev, "diffs event must be present");
		const parsed = JSON.parse(ev.attributes["gen_ai.diffs"]);
		assert.equal(parsed.length, 1);
		assert.equal(parsed[0].path, "auth.py");
		assert.equal(parsed[0].hunksTotal, 1);
		assert.equal(parsed[0].hunksShown, 1);
	});

	test("omits the event entirely when diffs is absent", () => {
		const span = buildStepSpan(RUN, "s1", "1000", "2000", base);
		assert.equal(span.events.find((e) => e.name === "gen_ai.content.diffs"), undefined);
	});

	test("omits the event when diffs is an empty array", () => {
		const span = buildStepSpan(RUN, "s1", "1000", "2000", { ...base, diffs: [] });
		assert.equal(span.events.find((e) => e.name === "gen_ai.content.diffs"), undefined);
	});

	test("a span with no diffs is unchanged from a span built without the field", () => {
		const withField = buildStepSpan(RUN, "s1", "1000", "2000", { ...base, diffs: undefined });
		const without = buildStepSpan(RUN, "s1", "1000", "2000", base);
		assert.deepEqual(withField, without);
	});
});

describe("trail_finish_run — session id", () => {
	test("includes gen_ai.harness.session_id when CLAUDE_CODE_SESSION_ID is set", async () => {
		const original = process.env.CLAUDE_CODE_SESSION_ID;
		process.env.CLAUDE_CODE_SESSION_ID = "0f962b5d-b5f1-42e0-a294-03819bc6eb8d";
		try {
			const attrs = await finishRunAndCaptureSpanAttributes();
			assert.equal(attrs["gen_ai.harness.session_id"]?.stringValue, "0f962b5d-b5f1-42e0-a294-03819bc6eb8d");
		} finally {
			if (original === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
			else process.env.CLAUDE_CODE_SESSION_ID = original;
		}
	});

	test("omits gen_ai.harness.session_id when CLAUDE_CODE_SESSION_ID is unset", async () => {
		const original = process.env.CLAUDE_CODE_SESSION_ID;
		delete process.env.CLAUDE_CODE_SESSION_ID;
		try {
			const attrs = await finishRunAndCaptureSpanAttributes();
			assert.equal("gen_ai.harness.session_id" in attrs, false);
		} finally {
			if (original !== undefined) process.env.CLAUDE_CODE_SESSION_ID = original;
		}
	});
});
