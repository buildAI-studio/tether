import { test, describe } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const APP_JS_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "static", "app.js");

function makeRunData(overrides = {}) {
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
		coverage: null,
		composition: null,
		...overrides,
	};
}

class FakeElement {
	// `register`, when given, is a getOrCreate(id) callback from the owning loadApp() call's id
	// map. Setting innerHTML on a real element makes any id="..." it contains reachable via
	// document.getElementById; this fake DOM has no real parent/child tree to walk for that, so
	// instead it scans the assigned HTML for an embedded `<script id="...">...</script>` (the
	// router's run-data payload is delivered exactly that way) and registers/populates that id
	// directly, mirroring what a real DOM would do.
	constructor(id, register) {
		this.id = id;
		this._innerHTML = "";
		this.textContent = "";
		this.title = "";
		this.style = { setProperty: () => {} };
		this.classList = { toggle() {}, contains() { return false; }, add() {}, remove() {} };
		this.dataset = {};
		this._attrs = {};
		this.children = [];
		this._scanned = [];
		this._listeners = {};
		this._register = register;
	}
	set innerHTML(v) {
		this._innerHTML = v;
		const scriptMatch = v.match(/<script[^>]*\sid="([^"]+)"[^>]*>([\s\S]*?)<\/script>/);
		if (scriptMatch && this._register) {
			this._register(scriptMatch[1]).textContent = scriptMatch[2];
		}
		// A fresh regex literal at the call site -- not a shared /g-flagged regex reused via
		// .exec(), which would carry lastIndex state across calls and silently miss matches on a
		// later, unrelated innerHTML assignment. Deliberately narrow: matches exactly what
		// renderSteps() emits today (<div class="step" data-i="N" ...), not a general HTML parser.
		this._scanned = [];
		for (const match of v.matchAll(/<div class="step" data-i="(\d+)"/g)) {
			const child = new FakeElement(null);
			child.dataset.i = match[1];
			child._classes = new Set(["step"]);
			this._scanned.push(child);
		}
	}
	get innerHTML() { return this._innerHTML; }
	setAttribute(n, v) { this._attrs[n] = v; }
	getAttribute(n) { return this._attrs[n] ?? null; }
	addEventListener(type, fn) { (this._listeners[type] ??= []).push(fn); }
	removeEventListener() {}
	appendChild(child) { this.children.push(child); child._parent = this; return child; }
	// Supports only a single leading-dot class selector, matched against this._scanned -- the
	// only form production code runs against freshly-rendered innerHTML content (renderSteps()'s
	// `.step` query). Anything else returns [].
	querySelectorAll(selector) {
		if (typeof selector !== "string" || !selector.startsWith(".")) return [];
		const className = selector.slice(1);
		return this._scanned.filter((el) => el._classes?.has(className));
	}
	querySelector() { return null; }
	click() { (this._listeners.click ?? []).forEach((fn) => fn()); }
	remove() { if (this._parent) { this._parent.children = this._parent.children.filter((c) => c !== this); this._parent = null; } }
	scrollIntoView() {}
	getBoundingClientRect() { return { left: 0, width: 100 }; }
}

class FakeSelectElement extends FakeElement {
	constructor(id) {
		super(id);
		this._options = [];
		this.value = "";
	}
	get selectedOptions() { return this._options.filter((o) => o.value === this.value); }
}

class FakeOptionElement {
	constructor(value, text, dataset) {
		this.value = value;
		this.textContent = text;
		this.hidden = false;
		this._attrs = { "data-entry": dataset.entry, "data-size": dataset.size };
	}
	getAttribute(n) { return this._attrs[n] ?? null; }
}

/** Seeds `elements.addWidgetPicker` (a FakeSelectElement with two real-ish `.options`: a blank
 * placeholder and one installed "cost-trend" widget) and `elements.widgetGrid` (a plain
 * FakeElement), the way Task 4's server-rendered analytics fragment would. Returns both so a test
 * can assert on them directly. */
function seedWidgetPicker(elements) {
	const picker = new FakeSelectElement("addWidgetPicker");
	picker.options = [
		new FakeOptionElement("", "Add widget…", {}),
		new FakeOptionElement("cost-trend", "Cost Trend", { entry: "dist/index.html", size: "medium" }),
	];
	elements.addWidgetPicker = picker;
	const grid = new FakeElement("widgetGrid");
	elements.widgetGrid = grid;
	return { picker, grid };
}

/** Loads app.js fresh into an isolated vm context with a minimal fake DOM, returning
 * `{ elements, windowStub, mountDetailPanel }` so a test can call mountDetailPanel(runData)
 * directly and assert on what actually landed in the fake elements' innerHTML. */
function loadApp() {
	const src = readFileSync(APP_JS_PATH, "utf-8");
	const elements = {};
	function getOrCreate(id) {
		if (!elements[id]) elements[id] = new FakeElement(id, getOrCreate);
		return elements[id];
	}
	const windowListeners = {};
	const documentListeners = {};
	const documentStub = {
		getElementById: (id) => getOrCreate(id),
		createElement: () => new FakeElement(null),
		addEventListener: (type, fn) => { (documentListeners[type] ??= []).push(fn); },
		removeEventListener: (type, fn) => { documentListeners[type] = (documentListeners[type] ?? []).filter((f) => f !== fn); },
		documentElement: new FakeElement("html"),
		querySelectorAll: () => [],
		querySelector: () => null,
	};
	getOrCreate("content");
	getOrCreate("rail");
	// A real browser's history.pushState(state, title, url) also updates window.location (here,
	// just .pathname -- this fake has no other URL parts to keep in sync). Mirroring that here
	// matters because onPluginPickerChange's "Native" branch reads window.location.pathname back
	// out to re-navigate to whatever path the router last pushed; only .pathname is kept in sync
	// (not .href), since several pre-existing tests assert .href stays "" across a client-side
	// (pushState) navigation to prove no full reload happened.
	const location = { pathname: "/", href: "" };
	const windowStub = {
		matchMedia: () => ({ matches: false }),
		requestAnimationFrame: () => 1,
		cancelAnimationFrame: () => {},
		addEventListener: (type, fn) => { (windowListeners[type] ??= []).push(fn); },
		removeEventListener: (type, fn) => { windowListeners[type] = (windowListeners[type] ?? []).filter((f) => f !== fn); },
		history: { pushState: (_state, _title, url) => { location.pathname = url; } },
		location,
		setInterval: () => 0,
		fetch: () => Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve("") }),
		__TETHER_INITIAL__: undefined,
	};
	const sandbox = { document: documentStub, window: windowStub, history: windowStub.history, location: windowStub.location, setInterval: windowStub.setInterval, fetch: windowStub.fetch, console, URL };
	vm.createContext(sandbox);
	vm.runInContext(src, sandbox, { filename: "app.js" });
	// vm contexts are a separate realm: plain objects returned from sandbox code have a
	// different Object.prototype than this file's, which trips assert.deepEqual's cross-realm
	// "same structure but not reference-equal" check. Round-tripping through JSON rebuilds the
	// return value as a plain object of this realm so structural assertions work normally --
	// the router's ShellState values are plain JSON-safe data, so this changes nothing observable.
	const rawParsePathname = sandbox.parsePathname;
	sandbox.parsePathname = (pathname) => {
		const result = rawParsePathname(pathname);
		return result === null ? null : JSON.parse(JSON.stringify(result));
	};
	return { elements, windowListeners, documentListeners, windowStub, sandbox, mountDetailPanel: sandbox.mountDetailPanel };
}

describe("mountDetailPanel", () => {
	test("renders the goal into the mission panel", () => {
		const { elements, mountDetailPanel } = loadApp();
		mountDetailPanel(makeRunData({ goal: "fix the bug" }));
		assert.match(elements.mission.innerHTML, /fix the bug/);
	});

	test("an unrecognized verdict does not throw and still renders", () => {
		const { elements, mountDetailPanel } = loadApp();
		assert.doesNotThrow(() => mountDetailPanel(makeRunData({ verdict: "totally-bogus" })));
		assert.match(elements.mission.innerHTML, /goal-title/);
	});

	test("a poisoned verdict of '__proto__' does not crash rendering via the prototype chain, and falls back to 'Not judged'", () => {
		const { elements, mountDetailPanel } = loadApp();
		assert.doesNotThrow(() => mountDetailPanel(makeRunData({ verdict: "__proto__" })));
		assert.match(elements.mission.innerHTML, /goal-title/);
		assert.match(elements.mission.innerHTML, /Not judged/);
	});

	test("a poisoned verdict of 'constructor' does not crash rendering via the prototype chain, and falls back to 'Not judged'", () => {
		const { elements, mountDetailPanel } = loadApp();
		assert.doesNotThrow(() => mountDetailPanel(makeRunData({ verdict: "constructor" })));
		assert.match(elements.mission.innerHTML, /goal-title/);
		assert.match(elements.mission.innerHTML, /Not judged/);
	});

	test("a judged run with a missing score does not render a completion percentage", () => {
		const { elements, mountDetailPanel } = loadApp();
		mountDetailPanel(makeRunData({ verdict: "met", score: null }));
		assert.equal(elements.mission.innerHTML.includes("Goal completion"), false);
	});

	test("a judged run with a real score renders the completion percentage", () => {
		const { elements, mountDetailPanel } = loadApp();
		mountDetailPanel(makeRunData({ verdict: "met", score: 0.75 }));
		assert.match(elements.mission.innerHTML, /Goal completion/);
		assert.match(elements.mission.innerHTML, /75%/);
	});

	test("judge narrative containing a script tag is escaped in the inspector panel", () => {
		const { elements, mountDetailPanel } = loadApp();
		mountDetailPanel(makeRunData({ verdict: "met", score: 0.5, narrative: "<script>alert(1)</script>" }));
		assert.match(elements.insp.innerHTML, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
		assert.equal(elements.insp.innerHTML.includes("<script>alert(1)</script>"), false);
	});

	test("unmount removes the window mousemove/mouseup and document keydown listeners it added", () => {
		const { windowListeners, documentListeners, mountDetailPanel } = loadApp();
		const unmount = mountDetailPanel(makeRunData());
		assert.equal((windowListeners.mousemove ?? []).length, 1);
		assert.equal((windowListeners.mouseup ?? []).length, 1);
		assert.equal((documentListeners.keydown ?? []).length, 1);
		unmount();
		assert.equal((windowListeners.mousemove ?? []).length, 0);
		assert.equal((windowListeners.mouseup ?? []).length, 0);
		assert.equal((documentListeners.keydown ?? []).length, 0);
	});

	test("renders a run's linked composition entries into #compositionEntries", () => {
		const { elements, mountDetailPanel } = loadApp();
		// composition is the nested CompositionView shape ({entries: [...]}) that
		// renderDetailFragment actually embeds in #run-data -- not a bare entries array.
		mountDetailPanel(makeRunData({
			composition: {
				entries: [{ source: "pre_tool_use_hook", kind: "tool_file", nameOrPath: "/a.ts", sizeBytes: 5, sessionId: "s1", timestamp: "2026-11-09T00:00:00.000Z" }],
			},
		}));
		assert.match(elements.compositionEntries.innerHTML, /\/a\.ts/);
	});

	test("shows the empty state in #compositionEntries when composition is null", () => {
		const { elements, mountDetailPanel } = loadApp();
		mountDetailPanel(makeRunData({ composition: null }));
		assert.match(elements.compositionEntries.innerHTML, /No composition data for this session\./);
	});
});

describe("router: path parsing and fragment URLs", () => {
	test("parsePathname recognizes all five route shapes and rejects everything else", () => {
		const { sandbox } = loadApp();
		// I2: "/" now resolves to a real state (most-recent-run detail), not null -- returning null
		// here is what used to send a Back navigation to "/" through navigateTo's full-reload
		// fallback instead of fetching client-side.
		assert.deepEqual(sandbox.parsePathname("/"), { view: "detail", traceId: null });
		assert.deepEqual(sandbox.parsePathname("/analytics"), { view: "analytics", traceId: null });
		assert.deepEqual(sandbox.parsePathname("/runs/" + "a".repeat(32)), { view: "detail", traceId: "a".repeat(32) });
		assert.deepEqual(sandbox.parsePathname("/runs/" + "a".repeat(32) + "/harness"), { view: "harness", traceId: "a".repeat(32) });
		assert.equal(sandbox.parsePathname("/something-else"), null);
	});

	test("fragmentUrlFor maps each ShellState to its matching /fragments/* URL", () => {
		const { sandbox } = loadApp();
		assert.equal(sandbox.fragmentUrlFor({ view: "detail", traceId: null }), "/fragments/detail");
		assert.equal(sandbox.fragmentUrlFor({ view: "analytics", traceId: null }), "/fragments/analytics");
		assert.equal(sandbox.fragmentUrlFor({ view: "harness", traceId: "b".repeat(32) }), "/fragments/harness/" + "b".repeat(32));
		assert.equal(sandbox.fragmentUrlFor({ view: "detail", traceId: "c".repeat(32) }), "/fragments/detail/" + "c".repeat(32));
	});
});

describe("router: navigation", () => {
	test("navigating to a recognized path fetches the right fragment and swaps #content", async () => {
		const { elements, windowStub, sandbox } = loadApp();
		windowStub.fetch = (url) => Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve("<p>analytics body</p>") });
		await sandbox.navigateTo("/analytics", true);
		assert.equal(elements.content.innerHTML, "<p>analytics body</p>");
	});

	test("navigating to an unrecognized path falls back to a full navigation instead of fetching", async () => {
		const { windowStub, sandbox } = loadApp();
		let fetched = false;
		windowStub.fetch = () => { fetched = true; return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve("") }); };
		await sandbox.navigateTo("/some/unknown/path", true);
		assert.equal(fetched, false);
		assert.equal(windowStub.location.href, "/some/unknown/path");
	});

	test("a fragment fetch that resolves 404 renders the not-found body directly, not the generic retry block", async () => {
		const { elements, windowStub, sandbox } = loadApp();
		windowStub.fetch = () => Promise.resolve({ ok: false, status: 404, text: () => Promise.resolve('<p class="empty">Run not found.</p>') });
		await sandbox.navigateTo("/runs/" + "d".repeat(32), true);
		assert.match(elements.content.innerHTML, /Run not found/);
		assert.doesNotMatch(elements.content.innerHTML, /Retry/);
	});

	test("a network failure during navigation renders a retry block", async () => {
		const { elements, windowStub, sandbox } = loadApp();
		windowStub.fetch = () => Promise.reject(new Error("network down"));
		await sandbox.navigateTo("/analytics", true);
		assert.match(elements.content.innerHTML, /Retry/);
	});

	test("navigating away from a mounted detail view unmounts it -- its window listeners are gone before the new panel mounts", async () => {
		const { elements, windowListeners, windowStub, sandbox } = loadApp();
		const detailHtml = '<script type="application/json" id="run-data">' + JSON.stringify({ traceId: "e".repeat(32), goal: "g", agent: "a", verdict: "unjudged", score: null, narrative: null, totals: { dur: "1s", cost: null, tokens: null, steps: 0 }, steps: [], coverage: null }) + "</script>";
		windowStub.fetch = (url) => Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(url.includes("/fragments/detail/") ? detailHtml : "<p>analytics body</p>") });

		await sandbox.navigateTo("/runs/" + "e".repeat(32), true);
		// mountDetailPanel's own initControls() ran for real here, registering its two window
		// listeners on the same windowListeners object Task 6's unmount test asserts against.
		assert.equal((windowListeners.mousemove ?? []).length, 1);
		assert.equal((windowListeners.mouseup ?? []).length, 1);

		await sandbox.navigateTo("/analytics", true);
		// navigateTo must have called the stored unmount() before swapping #content -- if it
		// didn't, these listeners would still be registered even though the Detail panel's DOM
		// (and the run-data it was mounted from) no longer exists.
		assert.equal((windowListeners.mousemove ?? []).length, 0);
		assert.equal((windowListeners.mouseup ?? []).length, 0);
		assert.equal(elements.content.innerHTML, "<p>analytics body</p>");
	});

	// I2: Back to "/" (the landing page, and the single most common Back target) must not fall
	// through to navigateTo's full-reload branch. Before the fix, parsePathname("/") returned null,
	// so this exact call would have set windowStub.location.href instead of fetching.
	test("navigating to '/' (e.g. a Back navigation to the landing page) fetches /fragments/detail instead of reloading", async () => {
		const { elements, windowStub, sandbox } = loadApp();
		let fetchedUrl = null;
		windowStub.fetch = (url) => { fetchedUrl = url; return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve("<p>latest run</p>") }); };

		await sandbox.navigateTo("/", false);

		assert.equal(fetchedUrl, "/fragments/detail");
		assert.equal(windowStub.location.href, ""); // unchanged -- a full reload would have set this
		assert.equal(elements.content.innerHTML, "<p>latest run</p>");
	});

	test("navigating to '/' resolves the Harness tab and rail to the server-resolved run's actual traceId", async () => {
		const { windowStub, sandbox } = loadApp();
		const harnessTab = new FakeElement("harnessTab", null);
		let setHref = null;
		harnessTab.setAttribute = (n, v) => { if (n === "href") setHref = v; };
		harnessTab.removeAttribute = () => {};
		harnessTab.classList = { toggle() {}, contains() { return false; }, add() {}, remove() {} };
		sandbox.document.querySelector = (sel) => (sel === '[data-nav="harness"]' ? harnessTab : null);

		const resolvedId = "i".repeat(32);
		const detailHtml = '<script type="application/json" id="run-data">' + JSON.stringify({ traceId: resolvedId, goal: "g", agent: "a", verdict: "unjudged", score: null, narrative: null, totals: { dur: "1s", cost: null, tokens: null, steps: 0 }, steps: [], coverage: null }) + "</script>";
		windowStub.fetch = () => Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(detailHtml) });

		await sandbox.navigateTo("/", false);

		// The client had no way to know resolvedId in advance -- parsePathname("/") only knows
		// traceId: null. This proves navigateTo read the actual resolved traceId back out of the
		// #run-data island the fetched fragment carried, not just target.traceId.
		assert.equal(setHref, "/runs/" + resolvedId + "/harness");
	});

	// I4: two overlapping navigations (e.g. two rail clicks in quick succession) must not let
	// whichever fetch happens to resolve last win the #content swap regardless of click order.
	test("a stale in-flight navigation is ignored once a newer navigation has started and finished", async () => {
		const { elements, windowStub, sandbox } = loadApp();
		const pushed = [];
		windowStub.history.pushState = (_state, _title, url) => pushed.push(url);

		let resolveFirstFetch;
		const firstFetchGate = new Promise((resolve) => { resolveFirstFetch = resolve; });
		let fetchCount = 0;
		windowStub.fetch = () => {
			fetchCount++;
			if (fetchCount === 1) {
				// The FIRST (soon-to-be-stale) navigation's fetch: deliberately held open until we
				// release it below, after the second navigation has already been kicked off.
				return firstFetchGate.then(() => ({ ok: true, status: 200, text: () => Promise.resolve("<p>first (stale)</p>") }));
			}
			return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve("<p>second (winner)</p>") });
		};

		const firstNav = sandbox.navigateTo("/analytics", true);
		const secondNav = sandbox.navigateTo("/runs/" + "k".repeat(32), true);
		resolveFirstFetch();
		await Promise.all([firstNav, secondNav]);

		// Only the second (later-started) navigation's result should have landed -- the first
		// navigation's late-arriving response must not have overwritten it.
		assert.equal(elements.content.innerHTML, "<p>second (winner)</p>");
		assert.deepEqual(pushed, ["/runs/" + "k".repeat(32)]);
	});
});

describe("router: rail polling", () => {
	test("after navigating to a run's Detail view, pollRail fetches /fragments/rail with that run marked active and replaces #rail", async () => {
		const { elements, windowStub, sandbox } = loadApp();
		windowStub.fetch = () => Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve("<p>run body</p>") });
		await sandbox.navigateTo("/runs/" + "l".repeat(32), true);

		let polledUrl = null;
		windowStub.fetch = (url) => { polledUrl = url; return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve("<a>polled rail</a>") }); };
		sandbox.pollRail();
		await new Promise((resolve) => setImmediate(resolve));

		assert.equal(polledUrl, "/fragments/rail?active=" + "l".repeat(32));
		assert.equal(elements.rail.innerHTML, "<a>polled rail</a>");
	});

	test("after navigating to Analytics, pollRail fetches /fragments/rail with no ?active= param", async () => {
		const { elements, windowStub, sandbox } = loadApp();
		windowStub.fetch = () => Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve("<p>analytics body</p>") });
		await sandbox.navigateTo("/analytics", true);

		let polledUrl = null;
		windowStub.fetch = (url) => { polledUrl = url; return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve("<a>polled rail</a>") }); };
		sandbox.pollRail();
		await new Promise((resolve) => setImmediate(resolve));

		assert.equal(polledUrl, "/fragments/rail");
		assert.equal(elements.rail.innerHTML, "<a>polled rail</a>");
	});

	test("a failed poll fetch does not throw and leaves #rail untouched", async () => {
		const { elements, windowStub, sandbox } = loadApp();
		elements.rail.innerHTML = "<a>original rail</a>";
		windowStub.fetch = () => Promise.reject(new Error("network down"));

		assert.doesNotThrow(() => sandbox.pollRail());
		await new Promise((resolve) => setImmediate(resolve));

		assert.equal(elements.rail.innerHTML, "<a>original rail</a>");
	});
});

describe("router: Harness tab sync", () => {
	test("navigateTo updates the Harness tab's href to the newly-selected run", async () => {
		const { windowStub, sandbox } = loadApp();
		const harnessTab = new FakeElement("harnessTab", null);
		let setHref = null;
		harnessTab.setAttribute = (n, v) => { if (n === "href") setHref = v; };
		harnessTab.removeAttribute = () => {};
		harnessTab.classList = { toggle() {}, contains() { return false; }, add() {}, remove() {} };
		sandbox.document.querySelector = (sel) => (sel === '[data-nav="harness"]' ? harnessTab : null);

		windowStub.fetch = (url) => Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve("<p>run body</p>") });
		await sandbox.navigateTo("/runs/" + "f".repeat(32), true);

		assert.equal(setHref, "/runs/" + "f".repeat(32) + "/harness");
	});

	test("navigateTo to /analytics disables the Harness tab", async () => {
		const { windowStub, sandbox } = loadApp();
		const harnessTab = new FakeElement("harnessTab", null);
		let removedHref = false;
		let addedDisabledClass = false;
		let ariaDisabled = null;
		harnessTab.removeAttribute = (n) => { if (n === "href") removedHref = true; };
		harnessTab.setAttribute = (n, v) => { if (n === "aria-disabled") ariaDisabled = v; };
		harnessTab.classList = { toggle() {}, contains() { return false; }, add: (c) => { if (c === "tab-disabled") addedDisabledClass = true; }, remove() {} };
		sandbox.document.querySelector = (sel) => (sel === '[data-nav="harness"]' ? harnessTab : null);

		windowStub.fetch = () => Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve("<p>analytics body</p>") });
		await sandbox.navigateTo("/analytics", true);

		assert.equal(removedHref, true);
		assert.equal(addedDisabledClass, true);
		assert.equal(ariaDisabled, "true");
	});

	test("clicking a disabled Harness tab does not trigger navigation", () => {
		const { sandbox } = loadApp();
		let navigated = false;
		sandbox.navigateTo = () => { navigated = true; return Promise.resolve(); };

		const anchor = {
			getAttribute: (n) => (n === "aria-disabled" ? "true" : null),
			href: "http://localhost/runs/" + "g".repeat(32) + "/harness",
		};
		const targetEl = { closest: () => anchor };
		const event = { target: targetEl, button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, preventDefault: () => {} };

		sandbox.onRailOrTabClick(event);

		assert.equal(navigated, false);
	});

	// Minor 6: the disabled-tab test above only proves navigateTo wasn't called -- that assertion
	// would pass just as well if the stub were never wired up correctly at all. This positive
	// companion proves the stub is actually live by clicking a non-disabled anchor and checking it
	// DOES fire, and with the expected pathname.
	test("clicking a non-disabled anchor does trigger navigation", () => {
		const { sandbox } = loadApp();
		let navigatedTo = null;
		sandbox.navigateTo = (pathname) => { navigatedTo = pathname; return Promise.resolve(); };

		const anchor = {
			getAttribute: () => null,
			href: "http://localhost/runs/" + "g".repeat(32) + "/harness",
		};
		const targetEl = { closest: () => anchor };
		const event = { target: targetEl, button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, preventDefault: () => {} };

		sandbox.onRailOrTabClick(event);

		assert.equal(navigatedTo, "/runs/" + "g".repeat(32) + "/harness");
	});
});

describe("plugin picker", () => {
	test("selecting a plugin option replaces #content with a sandboxed iframe pointed at the plugin's entry", async () => {
		const { elements, sandbox } = loadApp();
		await sandbox.navigateTo("/runs/" + "a".repeat(32), true);

		const picker = new FakeSelectElement("pluginPickerDetail");
		picker._options.push({ value: "waterfall-view", getAttribute: (n) => (n === "data-entry" ? "dist/index.html" : null) });
		picker.value = "waterfall-view";
		elements.pluginPickerDetail = picker;

		sandbox.onPluginPickerChange("detail");

		const content = elements.content;
		assert.equal(content.children.length, 1);
		const iframe = content.children[0];
		assert.equal(iframe.getAttribute("sandbox"), "allow-scripts allow-same-origin");
		assert.equal(iframe.src, `/plugins/waterfall-view/dist/index.html?traceId=${"a".repeat(32)}`);
	});

	test("selecting Native (empty value) re-navigates instead of mounting a frame", async () => {
		const { elements, sandbox } = loadApp();
		await sandbox.navigateTo("/runs/" + "a".repeat(32), true);

		const picker = new FakeSelectElement("pluginPickerDetail");
		picker.value = "";
		elements.pluginPickerDetail = picker;

		let navigatedTo = null;
		sandbox.navigateTo = (pathname) => { navigatedTo = pathname; return Promise.resolve(); };
		sandbox.onPluginPickerChange("detail");

		assert.equal(navigatedTo, "/runs/" + "a".repeat(32));
	});

	test("analytics slot's iframe src has no traceId query param", async () => {
		const { elements, sandbox } = loadApp();
		await sandbox.navigateTo("/analytics", true);

		const picker = new FakeSelectElement("pluginPickerAnalytics");
		picker._options.push({ value: "usage-explorer", getAttribute: (n) => (n === "data-entry" ? "index.html" : null) });
		picker.value = "usage-explorer";
		elements.pluginPickerAnalytics = picker;

		sandbox.onPluginPickerChange("analytics");

		assert.equal(elements.content.children[0].src, "/plugins/usage-explorer/index.html");
	});

	test("a native panel's unmount runs before a plugin frame mounts, so its stale listeners can't fire", async () => {
		const { windowListeners, elements, windowStub, sandbox } = loadApp();
		// Seed the fetch stub with a real #run-data island (same technique as the "navigating away
		// from a mounted detail view unmounts it" router test above) so navigateTo actually mounts a
		// live native detail panel via mountRunDataIfPresent()/mountDetailPanel(...), registering its
		// window mousemove/mouseup listeners for real -- not an empty body that never mounts anything.
		const detailHtml = '<script type="application/json" id="run-data">' + JSON.stringify({ traceId: "a".repeat(32), goal: "g", agent: "a", verdict: "unjudged", score: null, narrative: null, totals: { dur: "1s", cost: null, tokens: null, steps: 0 }, steps: [], coverage: null }) + "</script>";
		windowStub.fetch = () => Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(detailHtml) });

		await sandbox.navigateTo("/runs/" + "a".repeat(32), true);
		// Confirms the native panel really is mounted and live before the plugin picker is touched.
		assert.equal((windowListeners.mousemove ?? []).length, 1);
		assert.equal((windowListeners.mouseup ?? []).length, 1);

		const picker = new FakeSelectElement("pluginPickerDetail");
		picker._options.push({ value: "waterfall-view", getAttribute: (n) => (n === "data-entry" ? "dist/index.html" : null) });
		picker.value = "waterfall-view";
		elements.pluginPickerDetail = picker;
		sandbox.onPluginPickerChange("detail");

		// currentUnmount() must have run before the plugin frame mounted -- otherwise the native
		// panel's stale listeners would still be registered even though its DOM is gone.
		assert.equal((windowListeners.mousemove ?? []).length, 0);
		assert.equal((windowListeners.mouseup ?? []).length, 0);
		assert.equal(elements.content.children.length, 1);
		assert.equal(elements.content.children[0].src, `/plugins/waterfall-view/dist/index.html?traceId=${"a".repeat(32)}`);
	});
});

describe("plugin picker — registry install", () => {
	test("selecting a registry option installs it, then mounts the returned plugin", async () => {
		const { elements, windowStub, sandbox } = loadApp();
		await sandbox.navigateTo("/runs/" + "a".repeat(32), true);

		const picker = new FakeSelectElement("pluginPickerDetail");
		const registryOption = {
			value: "registry:waterfall-view",
			textContent: "Waterfall (install)",
			_attrs: {},
			setAttribute(n, v) { this._attrs[n] = v; },
			getAttribute(n) { return this._attrs[n] ?? null; },
		};
		picker._options.push(registryOption);
		picker.value = "registry:waterfall-view";
		elements.pluginPickerDetail = picker;

		let installBody = null;
		windowStub.fetch = (url, opts) => {
			if (url === "/api/v1/plugins/install") {
				installBody = JSON.parse(opts.body);
				return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, plugin: { slug: "waterfall-view", name: "Waterfall View", entry: "dist/index.html" }, compatible: true }) });
			}
			return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve("") });
		};

		await sandbox.onPluginPickerChange("detail");

		assert.deepEqual(installBody, { slug: "waterfall-view" });
		assert.equal(registryOption.value, "waterfall-view");
		assert.equal(registryOption.textContent, "Waterfall View");
		assert.equal(picker.value, "waterfall-view");
		assert.equal(elements.content.children[0].src, `/plugins/waterfall-view/dist/index.html?traceId=${"a".repeat(32)}`);
	});

	test("a failed install (non-2xx) resets the picker to Native instead of mounting anything", async () => {
		const { elements, windowStub, sandbox } = loadApp();
		await sandbox.navigateTo("/runs/" + "a".repeat(32), true);

		const picker = new FakeSelectElement("pluginPickerDetail");
		picker._options.push({ value: "registry:broken-plugin", getAttribute: () => null });
		picker.value = "registry:broken-plugin";
		elements.pluginPickerDetail = picker;

		windowStub.fetch = (url) => {
			if (url === "/api/v1/plugins/install") return Promise.resolve({ ok: false, status: 502, json: () => Promise.resolve({ ok: false, error: "git clone failed" }) });
			return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve("") });
		};

		await sandbox.onPluginPickerChange("detail");

		assert.equal(picker.value, "");
		assert.equal(elements.content.children.length, 0);
	});

	test("a network error during install resets the picker instead of throwing", async () => {
		const { elements, windowStub, sandbox } = loadApp();
		await sandbox.navigateTo("/runs/" + "a".repeat(32), true);

		const picker = new FakeSelectElement("pluginPickerDetail");
		picker._options.push({ value: "registry:broken-plugin", getAttribute: () => null });
		picker.value = "registry:broken-plugin";
		elements.pluginPickerDetail = picker;

		windowStub.fetch = () => Promise.reject(new Error("network down"));

		await assert.doesNotReject(sandbox.onPluginPickerChange("detail"));
		assert.equal(picker.value, "");
	});

	// Fix 5: a version-incompatible install is NOT the same thing as a real failure -- the plugin
	// genuinely landed on disk (matching the CLI's install-anyway-and-warn behavior), it just can't
	// be mounted. The picker still resets (nothing to mount), but the console message must be
	// distinguishable from a real failure: console.warn, not console.error.
	test("a version-incompatible install (compatible:false) resets the picker via console.warn, not console.error", async () => {
		const { elements, windowStub, sandbox } = loadApp();
		await sandbox.navigateTo("/runs/" + "a".repeat(32), true);

		const picker = new FakeSelectElement("pluginPickerDetail");
		picker._options.push({ value: "registry:future-plugin", getAttribute: () => null });
		picker.value = "registry:future-plugin";
		elements.pluginPickerDetail = picker;

		windowStub.fetch = (url) => {
			if (url === "/api/v1/plugins/install") {
				return Promise.resolve({
					ok: true,
					json: () => Promise.resolve({ ok: true, plugin: { slug: "future-plugin", name: "Future Plugin", entry: "index.html" }, compatible: false }),
				});
			}
			return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve("") });
		};

		const warnCalls = [];
		const errorCalls = [];
		sandbox.console = { warn: (...a) => warnCalls.push(a.join(" ")), error: (...a) => errorCalls.push(a.join(" ")) };

		await sandbox.onPluginPickerChange("detail");

		// (a) the picker still resets (nothing was mounted) ...
		assert.equal(picker.value, "");
		assert.equal(elements.content.children.length, 0);
		// (b) ... but via a warning, not an error, and with a message distinguishable from the
		// generic failure path (names the plugin and the actual reason, not just "Failed to install").
		assert.equal(errorCalls.length, 0);
		assert.equal(warnCalls.length, 1);
		assert.match(warnCalls[0], /future-plugin/);
		assert.match(warnCalls[0], /incompatible/);
	});

	// Fix 6: a genuine failure must not blank the picker out from under a plugin that's still
	// actually mounted -- it should revert to whatever was mounted before this attempt, not "".
	test("a failed install reverts the picker to the previously-mounted plugin's slug, not blank", async () => {
		const { elements, windowStub, sandbox } = loadApp();
		await sandbox.navigateTo("/runs/" + "a".repeat(32), true);

		const picker = new FakeSelectElement("pluginPickerDetail");
		picker._options.push({ value: "waterfall-view", getAttribute: (n) => (n === "data-entry" ? "dist/index.html" : null) });
		picker.value = "waterfall-view";
		elements.pluginPickerDetail = picker;
		// Mount an already-installed plugin first, exactly like the plain "selecting a plugin option"
		// test above -- this is the "previously mounted" state a subsequent failed install must
		// revert back to.
		sandbox.onPluginPickerChange("detail");
		assert.equal(elements.content.children.length, 1);

		picker._options.push({ value: "registry:broken-plugin", getAttribute: () => null });
		picker.value = "registry:broken-plugin";
		windowStub.fetch = (url) => {
			if (url === "/api/v1/plugins/install") return Promise.resolve({ ok: false, status: 502, json: () => Promise.resolve({ ok: false, error: "git clone failed" }) });
			return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve("") });
		};

		await sandbox.onPluginPickerChange("detail");

		assert.equal(picker.value, "waterfall-view");
	});

	// Fix 6: some user-visible signal beyond the devtools console -- the simplest option (a tooltip
	// via the <select>'s title attribute) must carry the actual error text.
	test("a failed install sets the picker's title to the error message", async () => {
		const { elements, windowStub, sandbox } = loadApp();
		await sandbox.navigateTo("/runs/" + "a".repeat(32), true);

		const picker = new FakeSelectElement("pluginPickerDetail");
		picker._options.push({ value: "registry:broken-plugin", getAttribute: () => null });
		picker.value = "registry:broken-plugin";
		elements.pluginPickerDetail = picker;

		windowStub.fetch = (url) => {
			if (url === "/api/v1/plugins/install") return Promise.resolve({ ok: false, status: 502, json: () => Promise.resolve({ ok: false, error: "git clone failed" }) });
			return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve("") });
		};

		await sandbox.onPluginPickerChange("detail");

		assert.match(picker.title, /broken-plugin/);
		assert.match(picker.title, /git clone failed/);
	});
});

describe("initWidgetDashboard", () => {
	test("does nothing when the analytics view has no widget grid/picker (e.g. Detail/Harness)", async () => {
		const { sandbox } = loadApp();
		await assert.doesNotReject(sandbox.initWidgetDashboard());
	});

	test("mounts one iframe per persisted slug, in order, and hides its picker option", async () => {
		const { elements, windowStub, sandbox } = loadApp();
		const { picker, grid } = seedWidgetPicker(elements);
		windowStub.fetch = (url) =>
			Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ slugs: ["cost-trend"] }) });
		await sandbox.initWidgetDashboard();
		assert.equal(grid.children.length, 1);
		assert.equal(picker.options[1].hidden, true);
	});

	test("a stale persisted slug with no matching installed widget is skipped, not thrown", async () => {
		const { elements, windowStub, sandbox } = loadApp();
		const { grid } = seedWidgetPicker(elements);
		windowStub.fetch = (url) =>
			Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ slugs: ["long-gone"] }) });
		await assert.doesNotReject(sandbox.initWidgetDashboard());
		assert.equal(grid.children.length, 0);
	});

	test("a fetch failure leaves the grid empty instead of throwing", async () => {
		const { elements, windowStub, sandbox } = loadApp();
		const { grid } = seedWidgetPicker(elements);
		windowStub.fetch = () => Promise.reject(new Error("network down"));
		await assert.doesNotReject(sandbox.initWidgetDashboard());
		assert.equal(grid.children.length, 0);
	});

	test("choosing a widget in the picker adds it to the grid, hides its option, and PUTs the new list", async () => {
		const { elements, windowStub, sandbox } = loadApp();
		const { picker, grid } = seedWidgetPicker(elements);
		const putCalls = [];
		windowStub.fetch = (url, opts) => {
			if (opts?.method === "PUT") { putCalls.push(JSON.parse(opts.body)); return Promise.resolve({ ok: true, status: 200 }); }
			return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ slugs: [] }) });
		};
		await sandbox.initWidgetDashboard();
		picker.value = "cost-trend";
		picker._listeners.change[0]();
		assert.equal(grid.children.length, 1);
		assert.equal(picker.options[1].hidden, true);
		assert.deepEqual(putCalls[putCalls.length - 1], { slugs: ["cost-trend"] });
	});

	test("clicking a widget card's remove button removes it from the grid, unhides its option, and PUTs the new list", async () => {
		const { elements, windowStub, sandbox } = loadApp();
		const { picker, grid } = seedWidgetPicker(elements);
		const putCalls = [];
		windowStub.fetch = (url, opts) => {
			if (opts?.method === "PUT") { putCalls.push(JSON.parse(opts.body)); return Promise.resolve({ ok: true, status: 200 }); }
			return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ slugs: ["cost-trend"] }) });
		};
		await sandbox.initWidgetDashboard();
		assert.equal(grid.children.length, 1);
		const removeBtn = grid.children[0].children[0].children[0];
		removeBtn._listeners.click[0]();
		assert.equal(grid.children.length, 0);
		assert.equal(picker.options[1].hidden, false);
		assert.deepEqual(putCalls[putCalls.length - 1], { slugs: [] });
	});

	test("choosing a registry option installs it, adds it to the grid, and persists the new list", async () => {
		const { elements, windowStub, sandbox } = loadApp();
		const { picker, grid } = seedWidgetPicker(elements);
		const registryOption = {
			value: "registry:latency-p95",
			textContent: "Latency P95 (install)",
			hidden: false,
			_attrs: {},
			setAttribute(n, v) { this._attrs[n] = v; },
			getAttribute(n) { return this._attrs[n] ?? null; },
		};
		picker.options.push(registryOption);
		const putCalls = [];
		windowStub.fetch = (url, opts) => {
			if (url === "/api/v1/plugins/install") {
				return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, plugin: { slug: "latency-p95", name: "Latency P95", entry: "dist/index.html", size: "small" }, compatible: true }) });
			}
			if (opts?.method === "PUT") { putCalls.push(JSON.parse(opts.body)); return Promise.resolve({ ok: true, status: 200 }); }
			return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ slugs: [] }) });
		};
		await sandbox.initWidgetDashboard();
		picker.value = "registry:latency-p95";
		await picker._listeners.change[0]();

		assert.equal(grid.children.length, 1);
		assert.equal(registryOption.value, "latency-p95");
		assert.equal(registryOption.hidden, true);
		assert.deepEqual(putCalls[putCalls.length - 1], { slugs: ["latency-p95"] });
	});

	// Fix 6: the widget-picker path gets the same treatment as the panel pickers -- restore the
	// picker's previous value (always "" for this stateless "Add widget…" control, see app.ts) on
	// failure rather than a bare hardcoded "", and surface the error via the picker's title.
	test("a failed registry install on the widget picker resets to blank and sets the picker's title to the error", async () => {
		const { elements, windowStub, sandbox } = loadApp();
		const { picker, grid } = seedWidgetPicker(elements);
		const registryOption = {
			value: "registry:broken-widget",
			textContent: "Broken Widget (install)",
			hidden: false,
			_attrs: {},
			setAttribute(n, v) { this._attrs[n] = v; },
			getAttribute(n) { return this._attrs[n] ?? null; },
		};
		picker.options.push(registryOption);
		windowStub.fetch = (url) => {
			if (url === "/api/v1/plugins/install") {
				return Promise.resolve({ ok: false, status: 502, json: () => Promise.resolve({ ok: false, error: "git clone failed" }) });
			}
			return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ slugs: [] }) });
		};
		await sandbox.initWidgetDashboard();
		picker.value = "registry:broken-widget";
		await picker._listeners.change[0]();

		assert.equal(grid.children.length, 0);
		assert.equal(picker.value, "");
		assert.match(picker.title, /broken-widget/);
		assert.match(picker.title, /git clone failed/);
	});
});

describe("renderIoPair / JSON tree rendering", () => {
	test("a string io value renders exactly as plain escaped text (unchanged from before)", () => {
		const { sandbox } = loadApp();
		const html = sandbox.renderIoPair(["Input", "pytest -x"]);
		assert.equal(html, '<div class="io-kind">Input</div><div class="io-block">pytest -x</div>');
	});

	test("an object io value renders as a collapsible JSON tree with escaped keys/values", () => {
		const { sandbox } = loadApp();
		const html = sandbox.renderIoPair(["Input", { file: "auth.py", ok: true }]);
		assert.match(html, /<div class="io-kind">Input<\/div>/);
		assert.match(html, /class="io-json"/);
		assert.match(html, /class="jv-key">file</);
		assert.match(html, /class="jv-str">"auth\.py"/);
		assert.match(html, /class="jv-scalar">true/);
	});

	test("a messages array io value renders as a role-labeled list, not generic JSON", () => {
		const { sandbox } = loadApp();
		const html = sandbox.renderIoPair(["Input", [{ role: "system", content: "be helpful" }, { role: "user", content: "hi" }]]);
		assert.match(html, /class="msg-role">system/);
		assert.match(html, /class="msg-role">user/);
		assert.doesNotMatch(html, /jv-node/);
	});

	test("HTML embedded in a structured string value is escaped, not injected", () => {
		const { sandbox } = loadApp();
		const html = sandbox.renderIoPair(["Output", { note: "<script>alert(1)</script>" }]);
		assert.doesNotMatch(html, /<script>alert/);
		assert.match(html, /&lt;script&gt;/);
	});

	test("an empty object/array renders its punctuation, not an empty collapsible node", () => {
		const { sandbox } = loadApp();
		assert.equal(sandbox.renderJsonNode({}), '<span class="jv-punct">{}</span>');
		assert.equal(sandbox.renderJsonNode([]), '<span class="jv-punct">[]</span>');
	});

	test("isMessageList rejects a plain object and a non-role-shaped array", () => {
		const { sandbox } = loadApp();
		assert.equal(sandbox.isMessageList({ file: "a.py" }), false);
		assert.equal(sandbox.isMessageList([1, 2, 3]), false);
		assert.equal(sandbox.isMessageList([]), false);
	});
});

describe("renderDiffs", () => {
	const render = (entries) => loadApp().sandbox.renderDiffs(entries);

	test("renders the file path and +/- lines", () => {
		const html = render([{ path: "auth.py", diff: "@@ -1 +1 @@\n-old\n+new\n", hunksShown: 1, hunksTotal: 1, bytesOmitted: 0, partialHunk: false }]);
		assert.ok(html.includes("auth.py"));
		assert.ok(html.includes("diff-add"), "added lines need their own class");
		assert.ok(html.includes("diff-del"), "removed lines need their own class");
	});

	test("shows a truncation banner naming hunks shown and bytes omitted", () => {
		const html = render([{ path: "big.py", diff: "@@ -1 +1 @@\n+x\n", hunksShown: 3, hunksTotal: 11, bytesOmitted: 48128, partialHunk: false }]);
		assert.ok(html.includes("3 of 11 hunks"));
		assert.ok(/47(\.\d+)?\s?KB|48128/.test(html), "omitted size must be stated");
	});

	test("says so when the last shown hunk is itself cut", () => {
		const html = render([{ path: "huge.py", diff: "@@ -1 +1 @@\n+y\n", hunksShown: 1, hunksTotal: 1, bytesOmitted: 90000, partialHunk: true }]);
		assert.ok(/cut|truncated/i.test(html), "a mid-hunk cut must be stated, not implied");
	});

	test("still shows a banner when partialHunk is true but hunksShown/hunksTotal/bytesOmitted all claim nothing was dropped", () => {
		const html = render([{ path: "sneaky.py", diff: "@@ -1 +1 @@\n+z\n", hunksShown: 1, hunksTotal: 1, bytesOmitted: 0, partialHunk: true }]);
		assert.ok(html.includes('class="diff-banner"'), "a mid-hunk cut must render a banner even when the counts alone look complete");
		assert.ok(/cut|truncated/i.test(html), "the banner must communicate the cut, not just imply it via omitted counts");
	});

	test("renders a header-only entry squeezed out by the step budget as changed-but-not-shown", () => {
		const html = render([{ path: "skipped.py", diff: "--- a/skipped.py\n+++ b/skipped.py\n", hunksShown: 0, hunksTotal: 4, bytesOmitted: 30000, partialHunk: false }]);
		assert.ok(html.includes("skipped.py"), "a changed file must stay visible");
		assert.ok(/not shown|0 of 4/i.test(html));
	});

	test("renders text that is not a unified diff as plain lines instead of dropping it", () => {
		const html = render([{ path: "weird.txt", diff: "this is not a diff at all", hunksShown: 0, hunksTotal: 0, bytesOmitted: 0, partialHunk: false }]);
		assert.ok(html.includes("this is not a diff at all"), "unparseable content must still be shown");
		assert.ok(html.includes("weird.txt"));
	});

	test("escapes HTML in diff content", () => {
		const html = render([{ path: "x.html", diff: "@@ -1 +1 @@\n+<script>alert(1)</script>\n", hunksShown: 1, hunksTotal: 1, bytesOmitted: 0, partialHunk: false }]);
		assert.ok(!html.includes("<script>alert(1)</script>"), "diff text is attacker-controlled and must be escaped");
	});

	test("a budget-truncated non-unified diff gets its own wording instead of '0 of 0 hunks shown'", () => {
		const html = render([{ path: "blob.txt", diff: "not a diff at all, just truncated text", hunksShown: 0, hunksTotal: 0, bytesOmitted: 4096, partialHunk: false }]);
		assert.ok(!html.includes("0 of 0 hunks"), "hunk-counting language is nonsensical when there were never any hunks");
		assert.ok(/truncated/i.test(html), "the banner must still say content was cut");
		assert.ok(html.includes("4KB") || html.includes("4096"), "the omitted size must still be stated");
	});
});

describe("step inspector: pinning via querySelectorAll/click", () => {
	test("querySelectorAll(\".step\") finds rendered step elements and their click listener is reachable", () => {
		const { elements, mountDetailPanel } = loadApp();
		mountDetailPanel(makeRunData({ steps: [
			{ type: "tool", title: "a", status: "ok", start: 0, dur: 1, cost: null, tok: null, io: [] },
			{ type: "tool", title: "b", status: "ok", start: 1, dur: 1, cost: null, tok: null, io: [] },
		] }));
		const stepEls = elements.steps.querySelectorAll(".step");
		assert.equal(stepEls.length, 2);
		stepEls[1].click();
		assert.match(elements.insp.innerHTML, /step 2/);
	});

	test("renders a key/before/after row for each changed arg when a pinned step has a non-empty argsDiff", () => {
		const { elements, mountDetailPanel } = loadApp();
		mountDetailPanel(makeRunData({ steps: [
			{ type: "tool", title: "edit_file", status: "err", start: 0, dur: 1, cost: null, tok: null, io: [],
				sig: [{ kind: "retry", count: 2, detail: "Attempt 2", argsDiff: [{ key: "text", before: "x", after: "y" }] }] },
		] }));
		elements.steps.querySelectorAll(".step")[0].click();
		assert.match(elements.insp.innerHTML, /argdiff-row/);
		assert.match(elements.insp.innerHTML, />text</);
		assert.match(elements.insp.innerHTML, />Before</);
		assert.match(elements.insp.innerHTML, />After</);
	});

	test("renders the identical-arguments message when a pinned step has an empty argsDiff", () => {
		const { elements, mountDetailPanel } = loadApp();
		mountDetailPanel(makeRunData({ steps: [
			{ type: "tool", title: "edit_file", status: "err", start: 0, dur: 1, cost: null, tok: null, io: [],
				sig: [{ kind: "retry", count: 2, detail: "Attempt 2", argsDiff: [] }] },
		] }));
		elements.steps.querySelectorAll(".step")[0].click();
		assert.match(elements.insp.innerHTML, /Retried with the exact same arguments\./);
		assert.doesNotMatch(elements.insp.innerHTML, /argdiff-row/);
	});

	test("renders no argsDiff block when a pinned step's signal has no argsDiff field", () => {
		const { elements, mountDetailPanel } = loadApp();
		mountDetailPanel(makeRunData({ steps: [
			{ type: "tool", title: "run tests", status: "err", start: 0, dur: 1, cost: null, tok: null, io: [],
				sig: [{ kind: "retry", count: 2, detail: "Attempt 2" }] },
		] }));
		elements.steps.querySelectorAll(".step")[0].click();
		assert.doesNotMatch(elements.insp.innerHTML, /argdiff/);
		assert.doesNotMatch(elements.insp.innerHTML, /Retried with the exact same arguments\./);
	});

	test("escapes an argsDiff key and value that contain HTML-special characters", () => {
		const { elements, mountDetailPanel } = loadApp();
		mountDetailPanel(makeRunData({ steps: [
			{ type: "tool", title: "edit_file", status: "err", start: 0, dur: 1, cost: null, tok: null, io: [],
				sig: [{ kind: "retry", count: 2, detail: "Attempt 2", argsDiff: [{ key: "<script>", before: "</div>", after: "ok" }] }] },
		] }));
		elements.steps.querySelectorAll(".step")[0].click();
		assert.doesNotMatch(elements.insp.innerHTML, /<script>/);
		assert.match(elements.insp.innerHTML, /&lt;script&gt;/);
	});

	test("renders a nested object's before/after values via the JSON tree renderer without crashing", () => {
		const { elements, mountDetailPanel } = loadApp();
		mountDetailPanel(makeRunData({ steps: [
			{ type: "tool", title: "call", status: "err", start: 0, dur: 1, cost: null, tok: null, io: [],
				sig: [{ kind: "retry", count: 2, detail: "Attempt 2", argsDiff: [{ key: "opts", before: { retries: 1 }, after: { retries: 2 } }] }] },
		] }));
		elements.steps.querySelectorAll(".step")[0].click();
		assert.match(elements.insp.innerHTML, /jv-node/);
		assert.match(elements.insp.innerHTML, /retries/);
	});
});

describe("composition-only sessions", () => {
	test("navigateTo mounts a #composition-data island, sets the title, and resolves the current state's traceId from the fetched composition data (not the URL's traceId)", async () => {
		const { elements, windowStub, sandbox } = loadApp();
		// Same technique as the "/" Harness-tab-resolution test above: wire up a fake Harness tab so
		// we can observe what traceId navigateTo actually resolved to, without reaching into
		// currentState directly (it's a `let` binding, not exposed on the sandbox).
		const harnessTab = new FakeElement("harnessTab", null);
		let setHref = null;
		harnessTab.setAttribute = (n, v) => { if (n === "href") setHref = v; };
		harnessTab.removeAttribute = () => {};
		harnessTab.classList = { toggle() {}, contains() { return false; }, add() {}, remove() {} };
		sandbox.document.querySelector = (sel) => (sel === '[data-nav="harness"]' ? harnessTab : null);

		// Deliberately different from the URL's traceId -- proves navigateTo reads the traceId back
		// out of the mounted #composition-data island (mountCompositionDataIfPresent's return value),
		// not target.traceId parsed from the URL.
		const urlTraceId = "p".repeat(32);
		const dataTraceId = "q".repeat(32);
		const compositionData = {
			traceId: dataTraceId,
			entries: [{ source: "hook", kind: "skill", nameOrPath: "superpowers:brainstorming", sizeBytes: 42, sessionId: "s".repeat(32), timestamp: "2024-01-01T00:00:00Z" }],
		};
		const compositionHtml = '<script type="application/json" id="composition-data">' + JSON.stringify(compositionData) + "</script>";
		windowStub.fetch = () => Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(compositionHtml) });

		await sandbox.navigateTo("/runs/" + urlTraceId, true);

		assert.match(elements.compositionEntries.innerHTML, /superpowers:brainstorming/);
		assert.match(sandbox.document.title, /Composition/);
		assert.equal(setHref, "/runs/" + dataTraceId + "/harness");
	});

	// Regression test for the bug Task 4 found and fixed by hand: a direct page load (bookmark,
	// refresh, shared link) of a composition-only session's URL is server-rendered with
	// #composition-data already in the DOM -- init()'s hydration path (not navigateTo's
	// fetch-based one) is what has to mount it. This was unguarded by any automated test until now.
	test("init(), given a bootstrapped detail state and a #composition-data island already in the DOM (a direct page load), populates #compositionEntries", () => {
		const { elements, windowStub, sandbox } = loadApp();
		const traceId = "r".repeat(32);
		const compositionData = {
			traceId,
			entries: [{ source: "hook", kind: "skill", nameOrPath: "superpowers:brainstorming", sizeBytes: 42, sessionId: "s".repeat(32), timestamp: "2024-01-01T00:00:00Z" }],
		};
		// Mirrors seedWidgetPicker's convention above: assign straight into the `elements` map to
		// simulate an element the server already rendered into the page, bypassing getOrCreate.
		const compositionEl = new FakeElement("composition-data");
		compositionEl.textContent = JSON.stringify(compositionData);
		elements["composition-data"] = compositionEl;

		windowStub.__TETHER_INITIAL__ = { view: "detail", traceId };

		sandbox.init();

		assert.match(elements.compositionEntries.innerHTML, /superpowers:brainstorming/);
	});
});
