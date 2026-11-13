import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { renderHarnessBody } from "../dist/templates/harness.js";

function view(overrides = {}) {
	return { traceId: "t".repeat(32), goal: "do the thing", startedAt: "2026-08-22T10:00:00.000Z", skills: [], subAgents: [], mcpServers: [], ...overrides };
}

function dataIsland(html) {
	const match = html.match(/<script type="application\/json" id="harness-data">([\s\S]*?)<\/script>/);
	return match ? JSON.parse(match[1]) : null;
}

describe("renderHarnessBody", () => {
	test("shows the run's goal and start time", () => {
		const html = renderHarnessBody(view({ goal: "fix the bug" }));
		assert.match(html, /fix the bug/);
	});

	test("shows a single empty message when every category has zero entries, with no graph markup", () => {
		const html = renderHarnessBody(view());
		assert.match(html, /No skills, sub-agents, or MCP servers discovered for this run\./);
		assert.doesNotMatch(html, /harnessGraphWrap/);
		assert.doesNotMatch(html, /harness-data/);
	});

	test("a non-empty harness renders the graph skeleton and a harness-data island carrying the entries", () => {
		const html = renderHarnessBody(
			view({
				skills: [{ name: "code-review", description: "reviews diffs", source: "project" }],
				subAgents: [{ name: "test-runner", description: "runs tests", tools: ["Bash", "Read"] }],
				mcpServers: [{ name: "github" }],
			})
		);
		assert.match(html, /id="harnessGraphWrap"/);
		assert.match(html, /id="hGraphSvg"/);
		const data = dataIsland(html);
		assert.ok(data);
		assert.equal(data.harness.skills[0].name, "code-review");
		assert.equal(data.harness.skills[0].description, "reviews diffs");
		assert.equal(data.harness.skills[0].source, "project");
		assert.deepEqual(data.harness.subAgents[0].tools, ["Bash", "Read"]);
		assert.equal(data.harness.mcpServers[0].name, "github");
		assert.equal(data.coverage, null);
	});

	test("passes the coverage view through into the data island unchanged", () => {
		const coverage = { tracked: true, entries: [{ type: "skill", name: "code-review", usedCount: 2 }] };
		const html = renderHarnessBody(view({ skills: [{ name: "code-review", description: "reviews diffs", source: "project" }] }), coverage);
		assert.deepEqual(dataIsland(html).coverage, coverage);
	});

	test("escapes an XSS skill name/description, and a name containing '</script>' cannot close the data island early", () => {
		const html = renderHarnessBody(
			view({ skills: [{ name: "</script><script>alert(1)</script>", description: "<img src=x onerror=alert(1)>", source: "project" }] })
		);
		assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
		assert.doesNotMatch(html, /<img src=x/);
		const data = dataIsland(html);
		assert.ok(data, "the data island must still parse as one well-formed <script> element");
		assert.equal(data.harness.skills[0].name, "</script><script>alert(1)</script>");
	});

	test("no longer renders a run picker", () => {
		const html = renderHarnessBody(view());
		assert.doesNotMatch(html, /runPicker/);
	});
});
