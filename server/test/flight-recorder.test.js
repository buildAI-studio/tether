import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { renderDetailFragment, renderEmptyDetailPanel } from "../dist/templates/flight-recorder.js";

function makeRunView(overrides = {}) {
	return {
		traceId: "t".repeat(32),
		goal: "do the thing",
		agent: "coding-agent",
		verdict: "met",
		score: 0.9,
		narrative: "Fully shipped and verified.",
		totals: { dur: "10s", cost: 0.05, tokens: 500, steps: 1 },
		steps: [
			{ type: "tool", title: "run tests", status: "ok", start: 0, dur: 5, cost: 0.05, tok: 500, io: [["Input", "pytest -x"], ["Output", "1 passed"]] },
		],
		...overrides,
	};
}

/** Extracts and JSON.parses the text content of the `id="run-data"` script tag, brace/string-aware
 * so it's robust to arbitrary content in string fields (semicolons, braces, etc). */
function extractRunData(html) {
	const marker = '<script type="application/json" id="run-data">';
	const start = html.indexOf(marker) + marker.length;
	assert.ok(start > marker.length - 1, "could not find the run-data script tag");
	const end = html.indexOf("</script>", start);
	return JSON.parse(html.slice(start, end));
}

describe("renderDetailFragment", () => {
	test("embeds the run and coverage as parseable JSON", () => {
		const html = renderDetailFragment(makeRunView({ goal: "fix the bug" }), { tracked: true, entries: [] });
		const data = extractRunData(html);
		assert.equal(data.goal, "fix the bug");
		assert.deepEqual(data.coverage, { tracked: true, entries: [] });
	});

	test("a null coverage argument round-trips as null", () => {
		const html = renderDetailFragment(makeRunView(), null);
		assert.equal(extractRunData(html).coverage, null);
	});

	test("includes the static skeleton the client renderer expects", () => {
		const html = renderDetailFragment(makeRunView(), null);
		for (const id of ["mission", "playBtn", "strip", "steps", "insp", "coverage"]) {
			assert.match(html, new RegExp(`id="${id}"`));
		}
	});

	test("a goal containing </script> cannot terminate the data script element early", () => {
		const html = renderDetailFragment(makeRunView({ goal: "</script><img src=x onerror=alert(1)>" }), null);
		// Only the run-data tag's own real closing </script> may appear before the skeleton starts.
		const dataOpenIdx = html.indexOf('<script type="application/json" id="run-data">');
		const realCloseIdx = html.indexOf("</script>", dataOpenIdx);
		const before = html.slice(dataOpenIdx, realCloseIdx);
		assert.equal(before.includes("</script><img"), false);
		assert.equal(extractRunData(html).goal, "</script><img src=x onerror=alert(1)>");
	});

	test("a goal containing $& or $' does not corrupt the injected JSON", () => {
		for (const goal of ["weird $& goal", "weird $' goal"]) {
			const html = renderDetailFragment(makeRunView({ goal }), null);
			assert.equal(extractRunData(html).goal, goal);
		}
	});

	test("does not render a <style> or <script> block of its own (moved to shell.ts / app.js)", () => {
		const html = renderDetailFragment(makeRunView(), null);
		assert.doesNotMatch(html, /<style>/);
		assert.doesNotMatch(html, /<script>\(function/);
	});
});

describe("renderDetailFragment with composition data", () => {
	test("embeds the composition field in the run-data island", () => {
		const composition = { entries: [{ source: "pre_tool_use_hook", kind: "tool_file", nameOrPath: "/a.ts", sizeBytes: 5, sessionId: "sess-1", timestamp: "2026-11-09T00:00:00.000Z" }] };
		const html = renderDetailFragment(makeRunView({ sessionId: "sess-1" }), null, composition);
		assert.deepEqual(extractRunData(html).composition, composition);
	});

	test("includes the Attached section markup even when composition is null", () => {
		const html = renderDetailFragment(makeRunView({ sessionId: null }), null, null);
		assert.match(html, /id="compositionEntries"/);
		assert.equal(extractRunData(html).composition, null);
	});
});

describe("renderEmptyDetailPanel", () => {
	test("shows an honest empty-state message", () => {
		assert.match(renderEmptyDetailPanel(), /No runs yet/);
	});
});
