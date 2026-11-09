import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { formatRelativeTime, renderRailBody } from "../dist/templates/rail.js";

function run(overrides = {}) {
	return { traceId: "t".repeat(32), goal: "do the thing", verdict: "met", dur: "10s", startedAt: "2026-08-22T10:00:00.000Z", ...overrides };
}

function runEntry(overrides = {}) {
	return { kind: "run", run: run(overrides) };
}

function compositionSession(overrides = {}) {
	return { traceId: "c".repeat(32), sessionId: "0f962b5d-1234-5678-9abc-def012345678", entryCount: 3, lastActivityAt: "2026-08-22T10:00:00.000Z", ...overrides };
}

function compositionEntry(overrides = {}) {
	return { kind: "composition", session: compositionSession(overrides) };
}

describe("formatRelativeTime", () => {
	const now = Date.parse("2026-08-22T12:00:00.000Z");

	test("under a minute reads 'just now'", () => {
		assert.equal(formatRelativeTime("2026-08-22T11:59:45.000Z", now), "just now");
	});
	test("minutes ago", () => {
		assert.equal(formatRelativeTime("2026-08-22T11:55:00.000Z", now), "5m ago");
	});
	test("hours ago", () => {
		assert.equal(formatRelativeTime("2026-08-22T09:00:00.000Z", now), "3h ago");
	});
	test("days ago", () => {
		assert.equal(formatRelativeTime("2026-08-19T12:00:00.000Z", now), "3d ago");
	});
	test("30 days or more falls back to the plain date", () => {
		assert.equal(formatRelativeTime("2026-01-01T12:00:00.000Z", now), "2026-01-01");
	});
	test("a malformed timestamp never throws, returns the raw string", () => {
		assert.equal(formatRelativeTime("not-a-date", now), "not-a-date");
	});
	test("a future timestamp (clock skew) falls back to the plain date, not a negative duration", () => {
		assert.equal(formatRelativeTime("2026-08-23T12:00:00.000Z", now), "2026-08-23");
	});
});

describe("renderRailBody", () => {
	test("an empty list shows an empty message", () => {
		assert.match(renderRailBody([], undefined, Date.now()), /No runs yet/);
	});

	test("marks the active run's row and not others", () => {
		const active = runEntry({ traceId: "a".repeat(32), goal: "active one" });
		const other = runEntry({ traceId: "b".repeat(32), goal: "other one" });
		const html = renderRailBody([active, other], "a".repeat(32), Date.now());
		const activeIdx = html.indexOf("active one");
		const otherIdx = html.indexOf("other one");
		const activeRowStart = html.lastIndexOf("<a", activeIdx);
		const otherRowStart = html.lastIndexOf("<a", otherIdx);
		assert.match(html.slice(activeRowStart, activeIdx), /rail-row-active/);
		assert.doesNotMatch(html.slice(otherRowStart, otherIdx), /rail-row-active/);
	});

	test("no run is marked active when activeTraceId is undefined", () => {
		const html = renderRailBody([runEntry()], undefined, Date.now());
		assert.doesNotMatch(html, /rail-row-active/);
	});

	test("escapes an XSS goal", () => {
		const html = renderRailBody([runEntry({ goal: "<script>alert(1)</script>" })], undefined, Date.now());
		assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
		assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
	});

	test("an unrecognized verdict falls back to the 'unjudged' dot color and label", () => {
		const html = renderRailBody([runEntry({ verdict: "totally-bogus" })], undefined, Date.now());
		assert.match(html, /#8A8F97/);
		assert.match(html, /Not judged/);
	});

	test("a poisoned verdict of '__proto__' does not crash rendering via the prototype chain, and falls back to 'unjudged'", () => {
		const html = renderRailBody([runEntry({ verdict: "__proto__" })], undefined, Date.now());
		assert.match(html, /#8A8F97/);
		assert.match(html, /Not judged/);
	});

	test("a poisoned verdict of 'constructor' does not crash rendering via the prototype chain, and falls back to 'unjudged'", () => {
		const html = renderRailBody([runEntry({ verdict: "constructor" })], undefined, Date.now());
		assert.match(html, /#8A8F97/);
		assert.match(html, /Not judged/);
	});

	test("each run row links to the run's detail page", () => {
		const html = renderRailBody([runEntry({ traceId: "c".repeat(32) })], undefined, Date.now());
		assert.match(html, new RegExp(`href="/runs/${"c".repeat(32)}"`));
	});

	test("renders a composition-only entry linking to the same /runs/:traceId pattern", () => {
		const html = renderRailBody([compositionEntry({ traceId: "d".repeat(32) })], undefined, Date.now());
		assert.match(html, new RegExp(`href="/runs/${"d".repeat(32)}"`));
	});

	test("a composition row carries a distinct class and badge, with no verdict dot or dot color", () => {
		const html = renderRailBody([compositionEntry()], undefined, Date.now());
		assert.match(html, /rail-row-composition/);
		assert.match(html, /rail-badge-composition/);
		assert.match(html, />no run</);
		// No verdict-dot span at all (rail-dot-goal's wrapper span is fine; it's the inner
		// `class="rail-dot"` -- the colored circle itself -- that a composition row never emits).
		assert.doesNotMatch(html, /class="rail-dot"/);
	});

	test("a composition row's label truncates the session id to 8 characters", () => {
		const html = renderRailBody([compositionEntry({ sessionId: "0f962b5d-1234-5678-9abc-def012345678" })], undefined, Date.now());
		assert.match(html, /Session 0f962b5d/);
		assert.doesNotMatch(html, /Session 0f962b5d-1234/);
	});

	test("a composition row falls back to 'Unknown session' when sessionId is empty", () => {
		const html = renderRailBody([compositionEntry({ sessionId: "" })], undefined, Date.now());
		assert.match(html, /Unknown session/);
	});

	test("a composition row uses the session's lastActivityAt for its relative-time span", () => {
		const now = Date.parse("2026-08-22T12:00:00.000Z");
		const html = renderRailBody([compositionEntry({ lastActivityAt: "2026-08-22T11:55:00.000Z" })], undefined, now);
		assert.match(html, /rail-time">5m ago</);
	});

	test("escapes an XSS session id in a composition row", () => {
		const html = renderRailBody([compositionEntry({ sessionId: "<script>alert(1)</script>" })], undefined, Date.now());
		assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
		assert.match(html, /&lt;script&gt;/);
	});

	test("marks a composition row active when its traceId matches activeTraceId", () => {
		const html = renderRailBody([compositionEntry({ traceId: "e".repeat(32) })], "e".repeat(32), Date.now());
		const rowStart = html.indexOf("<a");
		assert.match(html.slice(rowStart, html.indexOf(">", rowStart)), /rail-row-active/);
	});

	test("renders a mix of run and composition entries in the given order", () => {
		const html = renderRailBody([runEntry({ traceId: "f".repeat(32), goal: "a run" }), compositionEntry({ traceId: "g".repeat(32) })], undefined, Date.now());
		const runIdx = html.indexOf("a run");
		const compositionIdx = html.indexOf("rail-row-composition");
		assert.ok(runIdx !== -1 && compositionIdx !== -1 && runIdx < compositionIdx);
	});
});
