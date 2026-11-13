// Deliberately no IIFE/module wrapper around this file's top level: every top-level function
// declaration below becomes a `window` property, which is both how this file works as a plain
// classic <script> (no export {} to force ES-module treatment -- see tsconfig.json's
// moduleDetection: "legacy") and how test/app.test.js's vm-based harness reaches functions like
// mountDetailPanel/navigateTo/parsePathname directly as sandbox properties. Don't "fix" this by
// wrapping the file in an IIFE -- it'll silently break every router test.

// `composition` mirrors exactly what server/src/templates/flight-recorder.ts's
// renderDetailFragment embeds: the full CompositionView object ({entries: [...]}), not a bare
// entries array -- same inline-type-query convention `coverage` already uses just below for
// CoverageView. (Confirmed against the real wire format: server/test/server.test.js's
// "includes the run's own composition data when its session is linked" asserts
// `json.composition.entries.length`, i.e. the entries are nested one level under `composition`.)
type RunData = import("../runs.js").RunView & {
	coverage: import("../coverage.js").CoverageView | null;
	composition: import("../composition.js").CompositionView | null;
};

// Mirrors server/src/composition.ts's CompositionEntry -- deliberately redeclared rather than
// imported (same convention RunData above follows for RunView/CoverageView): this file compiles
// to a classic, non-module browser script (see the top-of-file note), so it can't pull in a
// server-only module's value exports without becoming one itself.
interface CompositionEntry {
	source: string;
	kind: string;
	nameOrPath: string;
	sizeBytes: number;
	contentPreview?: string;
	sessionId: string;
	timestamp: string;
}

interface CompositionData {
	traceId: string;
	entries: CompositionEntry[];
}

function $<T extends HTMLElement = HTMLElement>(id: string): T {
	const el = document.getElementById(id);
	if (!el) throw new Error(`missing #${id}`);
	return el as T;
}

// ---------- Icons (static, shared across every mount) ----------
const I: Record<string, string> = {
	reason: '<path d="M12 3a6 6 0 0 0-4 10.5V16h8v-2.5A6 6 0 0 0 12 3Z"/><path d="M9.5 19h5M10 21.5h4"/>',
	read: '<path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H11v15H5.5A1.5 1.5 0 0 1 4 17.5Z"/><path d="M20 5.5A1.5 1.5 0 0 0 18.5 4H13v15h5.5a1.5 1.5 0 0 0 1.5-1.5Z"/>',
	edit: '<path d="M4 20h4L18.5 9.5a2 2 0 0 0 0-2.8l-1.2-1.2a2 2 0 0 0-2.8 0L4 16Z"/><path d="M13.5 6.5l4 4"/>',
	run: '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M7.5 9.5l3 2.5-3 2.5M12.5 15h4"/>',
	tool: '<path d="M14.5 6.5a3.5 3.5 0 0 0-4.8 4.2l-5 5a1.6 1.6 0 0 0 2.3 2.3l5-5a3.5 3.5 0 0 0 4.2-4.8l-2.1 2.1-1.9-.2-.2-1.9Z"/>',
	llm: '<circle cx="12" cy="12" r="2.2"/><path d="M12 4v2M12 18v2M4 12h2M18 12h2M6.3 6.3l1.5 1.5M16.2 16.2l1.5 1.5M17.7 6.3l-1.5 1.5M7.8 16.2l-1.5 1.5"/>',
	search: '<circle cx="11" cy="11" r="6"/><path d="M20 20l-4.3-4.3"/>',
};
const SVG_LOOP = '<path d="M4 9a7 7 0 0 1 12-4l2 2M20 15a7 7 0 0 1-12 4l-2-2"/><path d="M18 3v4h-4M6 21v-4h4"/>';
function icon(t: string): string {
	return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' + (I[t] || I.tool) + '</svg>';
}
function svg(p: string, sw?: number): string {
	return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="' + (sw || 1.7) + '" stroke-linecap="round" stroke-linejoin="round">' + p + '</svg>';
}

const TYPE_COLOR: Record<string, [string, string]> = {
	reason: ["#8A85F2", "rgba(138,133,242,0.14)"], read: ["#5C93C4", "rgba(92,147,196,0.14)"],
	edit: ["#19b0c0", "rgba(25,176,192,0.15)"], run: ["#C98A5E", "rgba(201,138,94,0.15)"],
	tool: ["#C77DBB", "rgba(199,125,187,0.14)"], llm: ["#5FA8D3", "rgba(95,168,211,0.14)"],
	search: ["#6FA96B", "rgba(111,169,107,0.14)"],
};

function escapeHtml(s: string): string { return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" } as Record<string, string>)[c]); }

function isMessageList(v: unknown): v is { role: string; content: string }[] {
	return Array.isArray(v) && v.length > 0 && v.every((m) => m !== null && typeof m === "object" && typeof (m as Record<string, unknown>).role === "string" && typeof (m as Record<string, unknown>).content === "string");
}

function renderMessages(msgs: { role: string; content: string }[]): string {
	return msgs.map((m) => '<details class="msg-row" open><summary class="msg-role">' + escapeHtml(m.role) + '</summary><div class="io-block">' + escapeHtml(m.content) + "</div></details>").join("");
}

function renderJsonNode(v: unknown): string {
	if (v === null) return '<span class="jv-null">null</span>';
	if (typeof v === "string") return '<span class="jv-str">"' + escapeHtml(v) + '"</span>';
	if (typeof v === "number" || typeof v === "boolean") return '<span class="jv-scalar">' + String(v) + "</span>";
	if (Array.isArray(v)) {
		if (!v.length) return '<span class="jv-punct">[]</span>';
		const rows = v.map((item, idx) => '<div class="jv-row"><span class="jv-key">' + idx + '</span>' + renderJsonNode(item) + "</div>").join("");
		return '<details class="jv-node" open><summary>Array(' + v.length + ")</summary><div class=\"jv-children\">" + rows + "</div></details>";
	}
	if (typeof v === "object") {
		const entries = Object.entries(v as Record<string, unknown>);
		if (!entries.length) return '<span class="jv-punct">{}</span>';
		const rows = entries.map(([k, val]) => '<div class="jv-row"><span class="jv-key">' + escapeHtml(k) + '</span>' + renderJsonNode(val) + "</div>").join("");
		return '<details class="jv-node" open><summary>Object</summary><div class="jv-children">' + rows + "</div></details>";
	}
	return '<span class="jv-punct">' + escapeHtml(String(v)) + "</span>";
}

function renderIoPair(p: [string, string | unknown]): string {
	const [label, value] = p;
	const body =
		typeof value === "string" ? '<div class="io-block">' + escapeHtml(value) + "</div>"
		: isMessageList(value) ? renderMessages(value)
		: '<div class="io-json">' + renderJsonNode(value) + "</div>";
	return '<div class="io-kind">' + escapeHtml(label) + "</div>" + body;
}

function fmtBytes(n: number): string {
	return n >= 1024 ? (n / 1024).toFixed(n >= 10240 ? 0 : 1).replace(/\.0$/, "") + "KB" : n + "B";
}

/**
 * Renders agent-reported file diffs. Truncation is stated explicitly rather than implied: a diff
 * that looks complete but isn't will send a developer down the wrong path, so every omission gets
 * a banner and a mid-hunk cut says so in its own words.
 */
function renderDiffs(diffs: { path: string; diff: string; hunksShown: number; hunksTotal: number; bytesOmitted: number; partialHunk: boolean }[]): string {
	return diffs.map((d) => {
		const lines = d.diff.split("\n").map((ln) => {
			const cls = ln.startsWith("+") && !ln.startsWith("+++") ? "diff-add"
				: ln.startsWith("-") && !ln.startsWith("---") ? "diff-del"
				: ln.startsWith("@@") ? "diff-hunk"
				: "diff-ctx";
			return '<div class="' + cls + '">' + escapeHtml(ln) + "</div>";
		}).join("");

		const incomplete = d.hunksShown < d.hunksTotal || d.bytesOmitted > 0 || d.partialHunk;
		let banner = "";
		if (d.hunksTotal > 0 && d.hunksShown === 0) {
			banner = "Changed, but not shown — " + d.hunksTotal + " hunks omitted (" + fmtBytes(d.bytesOmitted) + ") to stay within this step's diff budget.";
		} else if (d.hunksTotal === 0 && d.bytesOmitted > 0) {
			// This diff never had hunks to begin with (unstructured/non-unified text) -- talking
			// about "0 of 0 hunks shown" here would be accurate but nonsensical, so state the
			// truncation on its own terms instead.
			banner = "Truncated — " + fmtBytes(d.bytesOmitted) + " omitted to stay within this step's diff budget.";
		} else if (incomplete) {
			// hunksShown/hunksTotal/bytesOmitted can all agree nothing was dropped while partialHunk is
			// still true (the last hunk itself was cut mid-way) -- state that on its own rather than
			// tacking "0 omitted" onto a sentence that would otherwise read as self-contradictory.
			const countsIncomplete = d.hunksShown < d.hunksTotal || d.bytesOmitted > 0;
			banner = countsIncomplete
				? d.hunksShown + " of " + d.hunksTotal + " hunks shown, " + fmtBytes(d.bytesOmitted) + " omitted."
					+ (d.partialHunk ? " The last hunk shown is itself cut mid-way." : "")
				: "The last hunk shown is cut mid-way — this diff is not complete.";
		}

		return '<div class="io-kind">' + escapeHtml(d.path) + "</div>"
			+ (banner ? '<div class="diff-banner">' + escapeHtml(banner) + "</div>" : "")
			+ '<div class="io-diff">' + lines + "</div>";
	}).join("");
}

// Object.assign(Object.create(null), ...) rather than a plain object literal: `runData.verdict`
// is attacker-controlled (arrives via the unauthenticated POST /traces endpoint, serialized
// straight through into the run-data JSON island). runs.ts's asVerdict() is the primary guard
// against a poisoned value like "__proto__" or "constructor" reaching this far -- but a
// null-prototype lookup table means even a value that somehow bypassed that boundary resolves via
// the `|| VERDICT.unjudged` fallback instead of walking the prototype chain to a function or
// Object.prototype, which would otherwise silently corrupt (rather than crash) the rendered badge.
const VERDICT: Record<string, { label: string; color: string; wash: string; line: string; glyph: string }> = Object.assign(Object.create(null), {
	met: { label: "Goal met", color: "var(--met)", wash: "var(--met-wash)", line: "rgba(47,162,74,0.35)", glyph: '<circle cx="12" cy="12" r="9"/><path d="M8 12.3l2.6 2.6L16 9.2"/>' },
	partial: { label: "Partial", color: "var(--partial)", wash: "var(--partial-wash)", line: "rgba(192,136,16,0.35)", glyph: '<circle cx="12" cy="12" r="9"/><path d="M12 7.5v5M12 15.7v.1"/>' },
	failed: { label: "Goal missed", color: "var(--failed)", wash: "var(--failed-wash)", line: "rgba(220,74,56,0.35)", glyph: '<circle cx="12" cy="12" r="9"/><path d="M9 9l6 6M15 9l-6 6"/>' },
	unjudged: { label: "Not judged", color: "var(--ink-3)", wash: "var(--panel-2)", line: "var(--line)", glyph: '<circle cx="12" cy="12" r="9"/><path d="M8 12h8"/>' },
});

/**
 * Mounts the Detail (Flight Recorder) panel into the skeleton renderDetailFragment already put in
 * #content, using `runData`. Relocated as-is from the page's old per-load inline <script> -- same
 * rendering/escaping logic, now callable once per navigation instead of once per page load.
 * Returns an unmount function the router must call before swapping #content to a different panel,
 * so this panel's window/document-level listeners (drag-to-scrub, spacebar) and any in-flight
 * requestAnimationFrame loop can't keep running against a panel that's no longer on screen.
 */
function mountDetailPanel(runData: RunData): () => void {
	let playT = 0, playing = false, speed = 1, raf: number | null = null, lastTs: number | null = null, pinnedStep: number | null = null, dragging = false;

	const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
	function runDur(r: RunData): number { return r.steps.reduce((m, s) => Math.max(m, s.start + s.dur), 0); }
	function fmtT(s: number): string { s = Math.max(0, Math.round(s)); return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0"); }
	function fmtCost(c: number | null): string { return c == null ? "" : "$" + c.toFixed(c < 1 ? 3 : 2); }
	function fmtTok(t: number | null): string { return t == null ? "" : (t >= 1000 ? (t / 1000).toFixed(1).replace(/\.0$/, "") + "k" : String(t)); }

	function ring(pct: number, color: string): string {
		const r = 18, C = 2 * Math.PI * r, on = (pct / 100) * C;
		return '<svg width="46" height="46" viewBox="0 0 46 46">'
			+ '<circle cx="23" cy="23" r="' + r + '" fill="none" stroke="var(--line)" stroke-width="5"/>'
			+ '<circle cx="23" cy="23" r="' + r + '" fill="none" stroke="' + color + '" stroke-width="5" stroke-linecap="round" stroke-dasharray="' + on.toFixed(1) + " " + C.toFixed(1) + '"/>'
			+ '<text class="pc-num" x="23" y="23" text-anchor="middle" dominant-baseline="central" transform="rotate(90 23 23)">' + pct + "</text></svg>";
	}

	function gm(k: string, v: string): string { return '<div class="gm"><span class="k">' + k + '</span><span class="v">' + v + "</span></div>"; }

	function renderMission(): void {
		const r = runData, v = VERDICT[r.verdict] || VERDICT.unjudged;
		const m = $("mission");
		m.style.setProperty("--vc", v.color); m.style.setProperty("--vc-wash", v.wash); m.style.setProperty("--vc-line", v.line);
		m.innerHTML =
			"<div>"
			+ '<div class="goal-eyebrow"><span>Goal</span> · <span class="agent-pill">@' + escapeHtml(r.agent) + "</span></div>"
			+ '<h1 class="goal-title">' + escapeHtml(r.goal) + "</h1>"
			+ '<div class="goal-meta">' + gm("Duration", r.totals.dur) + gm("Total cost", fmtCost(r.totals.cost) || "—") + gm("Steps", String(r.totals.steps)) + gm("Tokens", fmtTok(r.totals.tokens) || "—") + "</div>"
			+ "</div>"
			+ '<div class="verdict">'
			+ '<div class="verdict-badge"><svg class="glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' + v.glyph + "</svg>"
			+ '<div class="vt"><span class="lab">Verdict</span><span class="val">' + v.label + "</span></div></div>"
			+ (r.verdict !== "unjudged" && r.score != null ? '<div class="pcredit">' + ring(Math.round(r.score * 100), v.color)
				+ '<div class="pc-side"><div class="conf-row"><span>Goal completion</span><span>' + Math.round(r.score * 100) + "%</span></div></div></div>" : "")
			+ "</div>";
	}

	function renderStrip(): void {
		const r = runData, total = runDur(r), strip = $("strip");
		strip.querySelectorAll(".seg").forEach((n) => n.remove());
		r.steps.forEach((s, i) => {
			const seg = document.createElement("div");
			seg.className = "seg" + (s.status === "err" ? " err" : "");
			const left = total ? (s.start / total) * 100 : 0, w = total ? Math.max((s.dur / total) * 100, 1.2) : 100;
			seg.style.left = left + "%"; seg.style.width = w + "%"; seg.style.background = s.status === "err" ? "var(--failed-wash)" : TYPE_COLOR[s.type][1];
			seg.dataset.i = String(i); seg.title = s.title;
			seg.addEventListener("click", (e) => { e.stopPropagation(); seekTo(s.start + s.dur * 0.5); pinStep(i); });
			strip.appendChild(seg);
		});
		const area = $<SVGElement & HTMLElement>("costArea");
		const W = 1000, H = 100;
		area.setAttribute("viewBox", "0 0 " + W + " " + H);
		const totalCost = r.steps.reduce((a, s) => a + (s.cost || 0), 0);
		if (totalCost > 0 && total > 0) {
			let cum = 0;
			const pts: [number, number][] = [[0, H]];
			r.steps.forEach((s) => { cum += s.cost || 0; const x = ((s.start + s.dur) / total) * W; const y = H - (cum / totalCost) * H * 0.9; pts.push([x, y]); });
			pts.push([W, pts[pts.length - 1][1]]); pts.push([W, H]);
			const d = "M" + pts.map((p) => p[0].toFixed(1) + "," + p[1].toFixed(1)).join(" L");
			area.innerHTML = '<path d="' + d + ' Z" fill="var(--accent-wash)"/><path d="M0,' + H + " L" + pts.slice(1, -2).map((p) => p[0].toFixed(1) + "," + p[1].toFixed(1)).join(" L") + '" fill="none" stroke="var(--accent)" stroke-width="1.5" opacity="0.5"/>';
		} else {
			area.innerHTML = "";
		}
		$("axisEnd").textContent = "t = " + Math.round(total) + "s";
		$("clockTot").textContent = fmtT(total);
		renderSignals();
	}

	function renderSignals(): void {
		const r = runData, total = runDur(r), lane = $("signals");
		lane.querySelectorAll(".sig-m").forEach((n) => n.remove());
		if (!total) return;
		r.steps.forEach((s, i) => {
			if (!s.sig) return;
			s.sig.forEach((sg) => {
				const at = ((s.start + s.dur * 0.5) / total) * 100;
				const m = document.createElement("div");
				m.className = "sig-m"; m.style.left = at + "%";
				m.style.background = "var(--stuck)"; m.style.color = "#fff"; m.style.borderColor = "var(--stuck)";
				m.innerHTML = svg(SVG_LOOP, 1.9); m.title = "Retry loop ×" + sg.count + " — step " + (i + 1);
				m.addEventListener("click", () => { pinStep(i); seekTo(s.start + 0.3); });
				lane.appendChild(m);
			});
		});
	}

	function sBadges(s: RunData["steps"][number]): string {
		if (!s.sig) return "";
		return s.sig.map((sg) => '<span class="sbadge retry">' + svg(SVG_LOOP, 2) + "&times;" + sg.count + "</span>").join("");
	}

	function renderSteps(): void {
		const r = runData, el = $("steps");
		$("stepCount").textContent = r.steps.length + " step" + (r.steps.length === 1 ? "" : "s");
		if (!r.steps.length) { el.innerHTML = '<div class="insp-empty" style="padding:14px">No steps logged for this run.</div>'; return; }
		el.innerHTML = r.steps.map((s, i) => {
			const [c, w] = TYPE_COLOR[s.type];
			const stat = s.status === "err" ? '<span class="stat-chip stat-err">error</span>' : "";
			const metaBits = ["t+" + fmtT(s.start), s.dur + "s" + (fmtCost(s.cost) ? " · " + fmtCost(s.cost) : "")];
			return '<div class="step" data-i="' + i + '" role="button" tabindex="0" aria-selected="false" style="--tc:' + c + ";--tc-wash:" + w + '">'
				+ '<div class="rail"><div class="tick">' + icon(s.type) + "</div></div>"
				+ '<div class="body"><div class="st-title">' + escapeHtml(s.title) + " " + stat + sBadges(s) + "</div></div>"
				+ '<div class="meta">' + metaBits.join("<br>") + "</div></div>";
		}).join("");
		el.querySelectorAll<HTMLElement>(".step").forEach((node) => {
			const i = Number(node.dataset.i);
			node.addEventListener("click", () => { pinStep(i); seekTo(runData.steps[i].start + 0.3); });
			node.addEventListener("keydown", (e: KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pinStep(i); seekTo(runData.steps[i].start + 0.3); } });
		});
	}

	function currentStepIndex(): number {
		let idx = -1;
		runData.steps.forEach((s, i) => { if (playT >= s.start) idx = i; });
		return idx;
	}

	function renderInspector(): void {
		if (pinnedStep != null && runData.steps[pinnedStep]) renderStepIO(runData.steps[pinnedStep], pinnedStep);
		else renderVerdict(runData);
	}

	function renderVerdict(r: RunData): void {
		$("inspTitle").textContent = "Verdict";
		const insp = $("insp");
		if (r.verdict === "unjudged") {
			insp.innerHTML = '<div class="insp-section"><div class="insp-empty">No verdict — no goal-attainment judge was configured for this run (set TRAIL_JUDGE_PROVIDER/TRAIL_JUDGE_API_KEY to enable one).</div></div>';
			return;
		}
		const v = VERDICT[r.verdict] || VERDICT.unjudged;
		insp.style.setProperty("--vc", v.color);
		insp.innerHTML = '<div class="insp-section"><h3>LLM judge</h3><div class="judge-quote">' + escapeHtml(r.narrative || "") + "</div></div>";
	}

	function coverageList(entries: NonNullable<RunData["coverage"]>["entries"], emptyMsg: string): string {
		if (!entries.length) return '<div class="insp-empty">' + emptyMsg + "</div>";
		return entries.map((e) => {
			const used = e.usedCount > 0;
			const status = used ? "✓ used (" + e.usedCount + " step" + (e.usedCount === 1 ? "" : "s") + ")" : "— not used";
			return '<div class="cov-row"><span>' + escapeHtml(e.name) + '</span><span class="cov-status' + (used ? " cov-used" : "") + '">' + status + "</span></div>";
		}).join("");
	}

	function renderCoverage(): void {
		const cov = runData.coverage, el = $("coverage");
		if (!cov || !cov.entries.length) {
			el.innerHTML = '<div class="insp-empty">No skills, sub-agents, or MCP servers were registered for this run — nothing to show coverage for.</div>';
			return;
		}
		if (!cov.tracked) {
			el.innerHTML = '<div class="insp-empty">Coverage not tracked for this run — no step reported which skill, sub-agent, or MCP server it came from.</div>';
			return;
		}
		const skills = cov.entries.filter((e) => e.type === "skill");
		const subAgents = cov.entries.filter((e) => e.type === "sub_agent");
		const mcpServers = cov.entries.filter((e) => e.type === "mcp_server");
		el.innerHTML =
			'<div class="insp-section"><h3>Skills</h3>' + coverageList(skills, "No skills registered for this run.") + "</div>"
			+ '<div class="insp-section"><h3>Sub-agents</h3>' + coverageList(subAgents, "No sub-agents registered for this run.") + "</div>"
			+ '<div class="insp-section"><h3>MCP servers</h3>' + coverageList(mcpServers, "No MCP servers registered for this run.") + "</div>";
	}

	// Mirrors renderCoverage()'s exact structure. `runData.composition` is the nested
	// CompositionView ({entries: [...]} | null), not a bare array -- unwrap `.entries` before
	// handing it to renderCompositionEntries (already shared with the standalone
	// composition-only page via mountCompositionDataIfPresent); that helper already renders the
	// "No composition data for this session." empty state for a zero-length array, so an absent
	// composition (null) or one with no entries both fall through to the same message.
	function renderComposition(): void {
		const comp = runData.composition, el = $("compositionEntries");
		el.innerHTML = renderCompositionEntries(comp?.entries ?? []);
	}

	function renderStepIO(s: RunData["steps"][number], i: number): void {
		$("inspTitle").textContent = s.title + " · step " + (i + 1);
		const insp = $("insp");
		let inner = '<div class="pin-note"><span>&#9670; pinned to step ' + (i + 1) + '</span><button id="unpin">back to verdict</button></div>';
		if (s.sig) inner += s.sig.map((sg) => {
			let block = '<div class="io-sig"><span style="color:var(--stuck);display:grid;place-items:center">' + svg(SVG_LOOP, 1.9) + '</span><div><span class="st" style="color:var(--stuck)">Retry loop &times;' + sg.count + '</span><div style="color:var(--ink-2);margin-top:2px">' + escapeHtml(sg.detail) + "</div></div></div>";
			if (sg.argsDiff) {
				block += sg.argsDiff.length
					? '<div class="argdiff">' + sg.argsDiff.map((d) =>
						'<div class="argdiff-row"><div class="io-kind">' + escapeHtml(d.key) + '</div>'
						+ '<div class="argdiff-vals">'
						+ '<div><div class="io-kind">Before</div><div class="io-json">' + renderJsonNode(d.before) + '</div></div>'
						+ '<div><div class="io-kind">After</div><div class="io-json">' + renderJsonNode(d.after) + '</div></div>'
						+ '</div></div>'
					).join("") + '</div>'
					: '<div class="insp-empty">Retried with the exact same arguments.</div>';
			}
			return block;
		}).join("");
		if (s.diffs && s.diffs.length) inner += renderDiffs(s.diffs);
		if (s.io && s.io.length) inner += s.io.map((p) => renderIoPair(p)).join("");
		else if (!s.diffs || !s.diffs.length) inner += '<div class="insp-empty">No input/output recorded for this step.</div>';
		insp.innerHTML = inner;
		const un = document.getElementById("unpin");
		if (un) un.addEventListener("click", () => pinStep(null));
	}

	function updatePlayhead(): void {
		const r = runData, total = runDur(r), pct = total ? Math.min(100, (playT / total) * 100) : 0;
		$("playhead").style.left = pct + "%"; $("clockNow").textContent = fmtT(playT);
		$("strip").setAttribute("aria-valuenow", String(Math.round(pct)));
		let cost = 0, tok = 0, steps = 0;
		r.steps.forEach((s) => {
			if (playT >= s.start + s.dur) { cost += s.cost || 0; tok += s.tok || 0; steps++; }
			else if (playT >= s.start && s.dur > 0) { const f = (playT - s.start) / s.dur; cost += (s.cost || 0) * f; tok += Math.round((s.tok || 0) * f); }
		});
		$("accCost").textContent = fmtCost(cost) || "$0.00"; $("accSteps").textContent = steps + "/" + r.steps.length; $("accTok").textContent = fmtTok(tok) || "0";
		const ci = currentStepIndex();
		$("strip").querySelectorAll<HTMLElement>(".seg").forEach((seg) => {
			const i = Number(seg.dataset.i), s = r.steps[i];
			seg.classList.toggle("played", playT >= s.start); seg.classList.toggle("current", i === ci);
		});
		$("steps").querySelectorAll<HTMLElement>(".step").forEach((node) => {
			const i = Number(node.dataset.i);
			node.setAttribute("data-current", i === ci ? "true" : "false");
			node.setAttribute("aria-selected", pinnedStep === i ? "true" : "false");
		});
		if (pinnedStep == null && ci >= 0 && playing) {
			const node = $("steps").querySelector('.step[data-i="' + ci + '"]');
			if (node) node.scrollIntoView({ block: "nearest", behavior: reduceMotion ? "auto" : "smooth" });
		}
	}
	function seekTo(t: number): void { const total = runDur(runData); playT = Math.max(0, Math.min(total, t)); updatePlayhead(); }
	function pinStep(i: number | null): void { pinnedStep = i; renderInspector(); updatePlayhead(); }

	function tick(ts: number): void {
		if (!playing) return;
		if (lastTs == null) lastTs = ts;
		const dt = (ts - lastTs) / 1000; lastTs = ts; playT += dt * speed;
		const total = runDur(runData);
		if (playT >= total) { playT = total; setPlaying(false); updatePlayhead(); return; }
		updatePlayhead(); raf = requestAnimationFrame(tick);
	}
	function setPlaying(p: boolean): void {
		playing = p; lastTs = null;
		$("playIcon").innerHTML = p ? '<path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z"/>' : '<path d="M8 5v14l11-7z"/>';
		$("playBtn").setAttribute("aria-label", p ? "Pause replay" : "Play replay");
		if (p) { if (playT >= runDur(runData)) playT = 0; pinStep(null); raf = requestAnimationFrame(tick); }
		else if (raf != null) cancelAnimationFrame(raf);
	}

	function onWindowMouseMove(e: MouseEvent): void { if (dragging) seekFromEvent(e); }
	function onWindowMouseUp(): void { dragging = false; }
	function onDocumentKeydown(e: KeyboardEvent): void {
		const target = e.target as HTMLElement | null;
		if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
		if (e.key === " ") { e.preventDefault(); setPlaying(!playing); }
	}
	function seekFromEvent(e: MouseEvent | TouchEvent): void {
		const strip = $("strip");
		const rect = strip.getBoundingClientRect();
		const clientX = "touches" in e && e.touches.length ? e.touches[0].clientX : (e as MouseEvent).clientX;
		const x = (clientX - rect.left) / rect.width;
		seekTo(x * runDur(runData));
	}

	function initControls(): void {
		$("playBtn").addEventListener("click", () => setPlaying(!playing));
		$("speeds").querySelectorAll("button").forEach((b) => b.addEventListener("click", () => {
			speed = Number(b.dataset.sp);
			$("speeds").querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
		}));
		const strip = $("strip");
		strip.addEventListener("mousedown", (e: MouseEvent) => {
			if ((e.target as HTMLElement).classList.contains("seg")) return;
			dragging = true; setPlaying(false); seekFromEvent(e);
		});
		window.addEventListener("mousemove", onWindowMouseMove);
		window.addEventListener("mouseup", onWindowMouseUp);
		strip.addEventListener("keydown", (e: KeyboardEvent) => {
			const total = runDur(runData);
			if (e.key === "ArrowRight") { seekTo(playT + total * 0.02); e.preventDefault(); }
			if (e.key === "ArrowLeft") { seekTo(playT - total * 0.02); e.preventDefault(); }
		});
		document.addEventListener("keydown", onDocumentKeydown);
	}

	renderMission(); renderStrip(); renderSteps(); renderInspector(); renderCoverage(); renderComposition(); updatePlayhead(); initControls();

	return function unmount(): void {
		if (raf != null) cancelAnimationFrame(raf);
		window.removeEventListener("mousemove", onWindowMouseMove);
		window.removeEventListener("mouseup", onWindowMouseUp);
		document.removeEventListener("keydown", onDocumentKeydown);
	};
}

// ---------- Harness graph (ELK.js-laid-out map of skills/sub-agents/MCP servers) ----------

// elk.bundled.js (vendored, loaded as a classic <script> before this file -- see shell.ts) attaches
// a global `ELK` constructor. Declared ambiently rather than imported for the same reason this
// whole file has no import/export statements of its own (see the top-of-file note): an `import`
// here would force module treatment and break the classic-script contract.
declare const ELK: new () => { layout(graph: unknown): Promise<ElkLayoutNode> };

interface ElkLayoutNode {
	id: string;
	x?: number;
	y?: number;
	width?: number;
	height?: number;
	children?: ElkLayoutNode[];
}

type HarnessData = {
	harness: import("../harness.js").HarnessView;
	coverage: import("../coverage.js").CoverageView | null;
};

interface HGraphItem {
	id: string;
	kind: "skill" | "subagent" | "mcp";
	name: string;
	description?: string;
	tag?: string;
	tools?: string[];
	used: boolean | null; // null when coverage isn't tracked for this run
	height: number;
}

interface HGraphGroup {
	id: string;
	label: string;
	items: HGraphItem[];
}

const H_CARD_W = 236;
const H_CARD_GAP = 14;

function coverageUsed(coverage: HarnessData["coverage"], type: "skill" | "sub_agent" | "mcp_server", name: string): boolean | null {
	if (!coverage || !coverage.tracked) return null;
	const entry = coverage.entries.find((e) => e.type === type && e.name === name);
	return entry ? entry.usedCount > 0 : false;
}

function buildHarnessGroups(data: HarnessData): HGraphGroup[] {
	const { harness, coverage } = data;
	const groups: HGraphGroup[] = [
		{
			id: "skills", label: "Skills",
			items: harness.skills.map((s) => ({
				id: "skill:" + s.name, kind: "skill", name: s.name, description: s.description, tag: s.source,
				used: coverageUsed(coverage, "skill", s.name), height: 80,
			})),
		},
		{
			id: "subagents", label: "Sub-agents",
			items: harness.subAgents.map((a) => ({
				id: "subagent:" + a.name, kind: "subagent", name: a.name, description: a.description, tools: a.tools,
				used: coverageUsed(coverage, "sub_agent", a.name), height: a.tools.length ? 96 : 80,
			})),
		},
		{
			id: "mcp", label: "MCP servers",
			items: harness.mcpServers.map((m) => ({
				id: "mcp:" + m.name, kind: "mcp", name: m.name,
				used: coverageUsed(coverage, "mcp_server", m.name), height: 44,
			})),
		},
	];
	return groups.filter((g) => g.items.length > 0);
}

/** None of the three categories reference each other or their own siblings (no composition/handoff
 * data exists yet, see mcp/src/manifest.ts's known gaps) -- so there are no edges to lay out, only
 * unconnected cards to pack. ELK's "box" algorithm (rectangle packing, no edge routing) is exactly
 * that, applied twice: once to arrange the three category boxes, once per category to arrange its
 * cards. If a handoff graph ever exists, giving the inner graphs real edges and switching their
 * algorithm to "layered" is additive -- this packing shape doesn't need to change. */
function harnessElkGraph(groups: HGraphGroup[]): unknown {
	return {
		id: "root",
		layoutOptions: { "elk.algorithm": "box", "elk.spacing.nodeNode": "28", "elk.padding": "[top=16,left=16,bottom=16,right=16]" },
		children: groups.map((g) => ({
			id: g.id,
			layoutOptions: { "elk.algorithm": "box", "elk.spacing.nodeNode": String(H_CARD_GAP), "elk.padding": "[top=34,left=16,bottom=16,right=16]" },
			children: g.items.map((it) => ({ id: it.id, width: H_CARD_W, height: it.height })),
		})),
	};
}

function hDotHtml(used: boolean | null): string {
	if (used === null) return "";
	const title = used ? "Used at least once in this run" : "Registered but not used in this run";
	return `<span class="h-dot ${used ? "used" : "unused"}" title="${title}"></span>`;
}

function harnessCardInnerHtml(item: HGraphItem): string {
	if (item.kind === "mcp") {
		return `<div class="h-name">${hDotHtml(item.used)}<span>${escapeHtml(item.name)}</span></div>`;
	}
	const tagHtml = item.tag ? `<span class="h-tag">${escapeHtml(item.tag)}</span>` : "";
	const descHtml = item.description ? `<div class="h-desc" title="${escapeHtml(item.description)}">${escapeHtml(item.description)}</div>` : "";
	const toolsHtml = item.tools && item.tools.length
		? `<div class="h-tools" title="${escapeHtml(item.tools.join(", "))}">Tools: ${escapeHtml(item.tools.join(", "))}</div>`
		: "";
	return `<div class="h-name">${hDotHtml(item.used)}<span title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</span>${tagHtml}</div>${descHtml}${toolsHtml}`;
}

/** Renders the laid-out graph into #hGraphViewport and returns its full content bounding box
 * (for the Fit button / initial view). `layout` is the root ElkLayoutNode elk.layout() resolved. */
function renderHarnessGraph(viewport: SVGGElement, groups: HGraphGroup[], layout: ElkLayoutNode): { width: number; height: number } {
	const byId = new Map(groups.map((g) => [g.id, g]));
	let html = "";
	(layout.children || []).forEach((gLayout) => {
		const group = byId.get(gLayout.id);
		if (!group) return;
		const gx = gLayout.x || 0, gy = gLayout.y || 0, gw = gLayout.width || 0, gh = gLayout.height || 0;
		const itemsById = new Map(group.items.map((it) => [it.id, it]));
		html += `<rect class="h-group-box" x="${gx}" y="${gy}" width="${gw}" height="${gh}" rx="14"></rect>`;
		html += `<text class="h-group-label" x="${gx + 16}" y="${gy + 22}">${escapeHtml(group.label)} · ${group.items.length}</text>`;
		(gLayout.children || []).forEach((cLayout) => {
			const item = itemsById.get(cLayout.id);
			if (!item) return;
			const nx = gx + (cLayout.x || 0), ny = gy + (cLayout.y || 0), nw = cLayout.width || H_CARD_W, nh = cLayout.height || item.height;
			html += `<g class="h-node" data-id="${escapeHtml(item.id)}">`
				+ `<rect class="h-card-rect" x="${nx}" y="${ny}" width="${nw}" height="${nh}" rx="10"></rect>`
				+ `<foreignObject x="${nx}" y="${ny}" width="${nw}" height="${nh}"><div xmlns="http://www.w3.org/1999/xhtml" class="h-card">${harnessCardInnerHtml(item)}</div></foreignObject>`
				+ `</g>`;
		});
	});
	viewport.innerHTML = html;
	return { width: layout.width || 0, height: layout.height || 0 };
}

/** Mounts the Harness panel's graph into the skeleton renderHarnessBody put in #content, using the
 * `#harness-data` island. Returns an unmount function the router calls before the next navigation,
 * same contract as mountDetailPanel -- here it only needs to drop this panel's pointer/wheel
 * listeners off #hGraphSvg (window/document-level listeners would otherwise outlive the panel). */
function mountHarnessPanel(data: HarnessData): () => void {
	const wrapEl = document.getElementById("harnessGraphWrap");
	const svgElOrNull = document.getElementById("hGraphSvg") as (SVGSVGElement & HTMLElement) | null;
	const viewportOrNull = document.getElementById("hGraphViewport") as unknown as SVGGElement | null;
	if (!wrapEl || !svgElOrNull || !viewportOrNull) return () => {};
	// Rebound to const bindings TypeScript can prove non-null inside the closures below -- the
	// guard above doesn't narrow across a nested function declaration (same pattern/reason as
	// initWidgetDashboard's `const grid = gridEl;` above).
	const wrap = wrapEl, svgEl = svgElOrNull, viewport = viewportOrNull;

	const groups = buildHarnessGroups(data);
	let content = { width: 0, height: 0 };
	let t = { x: 0, y: 0, k: 1 };
	let dragging = false, dragLast = { x: 0, y: 0 };

	function applyTransform(): void {
		viewport.setAttribute("transform", `translate(${t.x} ${t.y}) scale(${t.k})`);
	}

	function fit(): void {
		if (!content.width || !content.height) return;
		const rect = wrap.getBoundingClientRect();
		const k = Math.min((rect.width - 40) / content.width, (rect.height - 40) / content.height, 1.4);
		t = { k, x: (rect.width - content.width * k) / 2, y: (rect.height - content.height * k) / 2 };
		applyTransform();
	}

	function zoomBy(factor: number): void {
		const rect = wrap.getBoundingClientRect();
		const cx = rect.width / 2, cy = rect.height / 2;
		const k = Math.max(0.15, Math.min(3, t.k * factor));
		t = { k, x: cx - ((cx - t.x) / t.k) * k, y: cy - ((cy - t.y) / t.k) * k };
		applyTransform();
	}

	function onWheel(e: WheelEvent): void {
		e.preventDefault();
		const rect = svgEl.getBoundingClientRect();
		const cx = e.clientX - rect.left, cy = e.clientY - rect.top;
		const k = Math.max(0.15, Math.min(3, t.k * (e.deltaY < 0 ? 1.1 : 0.9)));
		t = { k, x: cx - ((cx - t.x) / t.k) * k, y: cy - ((cy - t.y) / t.k) * k };
		applyTransform();
	}
	function onPointerDown(e: PointerEvent): void {
		if (e.button !== 0) return;
		dragging = true; dragLast = { x: e.clientX, y: e.clientY };
		svgEl.classList.add("panning");
		svgEl.setPointerCapture(e.pointerId);
	}
	function onPointerMove(e: PointerEvent): void {
		if (!dragging) return;
		t = { ...t, x: t.x + (e.clientX - dragLast.x), y: t.y + (e.clientY - dragLast.y) };
		dragLast = { x: e.clientX, y: e.clientY };
		applyTransform();
	}
	function onPointerUp(): void { dragging = false; svgEl.classList.remove("panning"); }
	function onNodeEnter(e: Event): void {
		const node = (e.target as Element).closest(".h-node");
		if (!node) return;
		svgEl.classList.add("dim");
		node.classList.add("hl");
	}
	function onNodeLeave(e: Event): void {
		const node = (e.target as Element).closest(".h-node");
		if (!node) return;
		svgEl.classList.remove("dim");
		node.classList.remove("hl");
	}

	svgEl.addEventListener("wheel", onWheel, { passive: false });
	svgEl.addEventListener("pointerdown", onPointerDown);
	svgEl.addEventListener("pointermove", onPointerMove);
	svgEl.addEventListener("pointerup", onPointerUp);
	svgEl.addEventListener("pointerleave", onPointerUp);
	svgEl.addEventListener("pointerover", onNodeEnter);
	svgEl.addEventListener("pointerout", onNodeLeave);
	document.getElementById("hGraphZoomIn")?.addEventListener("click", () => zoomBy(1.25));
	document.getElementById("hGraphZoomOut")?.addEventListener("click", () => zoomBy(0.8));
	document.getElementById("hGraphZoomFit")?.addEventListener("click", fit);

	new ELK().layout(harnessElkGraph(groups)).then((layout) => {
		content = renderHarnessGraph(viewport, groups, layout);
		fit();
	});

	return function unmount(): void {
		svgEl.removeEventListener("wheel", onWheel);
		svgEl.removeEventListener("pointerdown", onPointerDown);
		svgEl.removeEventListener("pointermove", onPointerMove);
		svgEl.removeEventListener("pointerup", onPointerUp);
		svgEl.removeEventListener("pointerleave", onPointerUp);
		svgEl.removeEventListener("pointerover", onNodeEnter);
		svgEl.removeEventListener("pointerout", onNodeLeave);
	};
}

/** Mounts the embedded #harness-data island if present (an empty-categories harness panel has
 * none -- renderHarnessBody skips straight to the empty-state message in that case). Mirrors
 * mountRunDataIfPresent's null-if-absent contract. */
function mountHarnessIfPresent(): void {
	const dataEl = document.getElementById("harness-data");
	if (!dataEl) return;
	const data = JSON.parse(dataEl.textContent || "null") as HarnessData | null;
	if (!data) return;
	currentUnmount = mountHarnessPanel(data);
}

// ---------- Router ----------

interface ShellState {
	view: "detail" | "harness" | "analytics";
	traceId: string | null;
}

// `declare global` requires the file to be a module (i.e. have a top-level import/export), which
// this file deliberately has none of so it compiles as a classic script. A plain type alias plus
// a cast at the one read site below achieves the same typing without that requirement.
type WindowWithInitialState = Window & { __TETHER_INITIAL__?: ShellState };

let currentUnmount: (() => void) | null = null;
let currentState: ShellState = { view: "detail", traceId: null };

// Monotonically-increasing navigation token (I4): incremented at the start of every navigateTo
// call. A navigation checks, after each await, whether it's still the most recently started one
// before touching #content/currentState/history -- so two overlapping navigations (e.g. two rail
// clicks in quick succession) can never race, regardless of which fetch resolves first.
let navSeq = 0;

function parsePathname(pathname: string): ShellState | null {
	// "/" resolves to the most recent run's Detail panel, same as the server does -- returning a
	// real state here (not null) lets the router fetch it client-side via /fragments/detail
	// instead of falling through to navigateTo's full-reload branch. That fallback is exactly what
	// used to make a Back navigation to "/" (the most common Back target, since "/" is the landing
	// page) always full-reload -- see I2.
	if (pathname === "/") return { view: "detail", traceId: null };
	if (pathname === "/analytics") return { view: "analytics", traceId: null };
	const harnessMatch = pathname.match(/^\/runs\/([^/]+)\/harness$/);
	if (harnessMatch) return { view: "harness", traceId: decodeURIComponent(harnessMatch[1]) };
	const detailMatch = pathname.match(/^\/runs\/([^/]+)$/);
	if (detailMatch) return { view: "detail", traceId: decodeURIComponent(detailMatch[1]) };
	return null;
}

function fragmentUrlFor(state: ShellState): string {
	if (state.view === "analytics") return "/fragments/analytics";
	if (state.view === "harness") return `/fragments/harness/${encodeURIComponent(state.traceId as string)}`;
	if (state.traceId == null) return "/fragments/detail";
	return `/fragments/detail/${encodeURIComponent(state.traceId)}`;
}

function setTabActive(view: ShellState["view"]): void {
	document.querySelectorAll(".tabbar .tab").forEach((el) => {
		el.classList.toggle("tab-active", el.getAttribute("data-nav") === view);
	});
}

function setRailActive(traceId: string | null): void {
	document.querySelectorAll("#rail a.rail-row").forEach((el) => {
		el.classList.toggle("rail-row-active", el.getAttribute("data-trace-id") === traceId);
	});
}

const PLUGIN_PICKER_IDS: Record<ShellState["view"], string> = {
	detail: "pluginPickerDetail",
	harness: "pluginPickerHarness",
	analytics: "pluginPickerAnalytics",
};

// Tracks, per slot, the picker value that's actually mounted right now (an installed plugin's
// slug, or "" for Native) -- separate from `select.value`, which a change event has already
// overwritten with the user's new (not-yet-installed/mounted) choice by the time the handler below
// runs. onPluginPickerChange reads this to know what to revert the visible <select> to if an
// install attempt fails, instead of unconditionally snapping back to "" and hiding a plugin that's
// still actually mounted underneath.
const mountedPluginValue: Record<ShellState["view"], string> = { detail: "", harness: "", analytics: "" };

function setPluginPickerVisibility(view: ShellState["view"]): void {
	(Object.keys(PLUGIN_PICKER_IDS) as Array<ShellState["view"]>).forEach((slot) => {
		const el = document.getElementById(PLUGIN_PICKER_IDS[slot]) as HTMLSelectElement | null;
		mountedPluginValue[slot] = "";
		if (!el) return;
		el.style.display = slot === view ? "" : "none";
		el.value = "";
	});
}

function mountPluginFrame(slug: string, entry: string, slot: ShellState["view"]): void {
	const iframe = document.createElement("iframe") as HTMLIFrameElement;
	iframe.className = "plugin-frame";
	iframe.setAttribute("sandbox", "allow-scripts allow-same-origin");
	const query = slot === "analytics" ? "" : `?traceId=${encodeURIComponent(currentState.traceId ?? "")}`;
	iframe.src = `/plugins/${encodeURIComponent(slug)}/${entry}${query}`;
	const content = $("content");
	content.innerHTML = "";
	content.appendChild(iframe);
}

function onPluginPickerChange(slot: ShellState["view"]): Promise<void> | void {
	const select = document.getElementById(PLUGIN_PICKER_IDS[slot]) as HTMLSelectElement | null;
	if (!select) return;
	// Captured before `raw` below: by the time a "change" event fires, the browser has already
	// overwritten select.value with the user's new pick, so this is the only place that still knows
	// what was actually mounted a moment ago.
	const previousValue = mountedPluginValue[slot];
	const raw = select.value;
	if (raw.startsWith("registry:")) {
		const registrySlug = raw.slice("registry:".length);
		const option = select.selectedOptions[0];
		return installFromRegistry(select, registrySlug).then((plugin) => {
			// Install failed (or installed but version-incompatible, see installFromRegistry) --
			// revert the visible selection to whatever's still actually mounted, not blindly to ""
			// (which would show "Native" even while a different plugin's iframe is still on screen).
			if (!plugin) { select.value = previousValue; return; }
			if (option) {
				option.value = plugin.slug;
				option.textContent = plugin.name;
				option.setAttribute("data-entry", plugin.entry);
			}
			if (currentUnmount) { currentUnmount(); currentUnmount = null; }
			select.value = plugin.slug;
			mountedPluginValue[slot] = plugin.slug;
			mountPluginFrame(plugin.slug, plugin.entry, slot);
		});
	}
	if (currentUnmount) { currentUnmount(); currentUnmount = null; }
	if (raw === "") {
		mountedPluginValue[slot] = "";
		navigateTo(window.location.pathname, false);
		return;
	}
	const option = select.selectedOptions[0];
	const entry = option?.getAttribute("data-entry") ?? "";
	mountedPluginValue[slot] = raw;
	mountPluginFrame(raw, entry, slot);
}

interface InstalledPluginResponse {
	slug: string;
	name: string;
	entry: string;
	size?: string;
}

interface InstallApiResponse {
	ok: boolean;
	plugin?: InstalledPluginResponse;
	compatible?: boolean;
	error?: string;
}

/** POSTs a registry slug to /api/v1/plugins/install and returns the installed plugin's data, or
 * null on any failure (network error, non-2xx, missing plugin) OR a version-incompatible install --
 * the caller resets its own picker in either case, since there's genuinely nothing to mount. Those
 * two null-returning cases are NOT the same thing, though: a version mismatch means the install on
 * disk actually succeeded (matching the CLI's install-anyway-and-warn behavior), it just can't be
 * mounted -- so it's logged via console.warn with a distinct, informative message instead of being
 * lumped in with a real failure under console.error. A real failure also sets `select.title` (a
 * simple, unobtrusive tooltip) to the error message so something is visible beyond the devtools
 * console; the version-mismatch case doesn't, since nothing went wrong. Disables `select` for the
 * duration of the request so a second click can't fire a concurrent install of the same slug. */
async function installFromRegistry(select: HTMLSelectElement, registrySlug: string): Promise<InstalledPluginResponse | null> {
	select.disabled = true;
	try {
		const res = await window.fetch("/api/v1/plugins/install", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ slug: registrySlug }),
		});
		const body = (await res.json().catch(() => null)) as InstallApiResponse | null;
		if (!res.ok || !body?.ok || !body.plugin) {
			const message = `Failed to install plugin "${registrySlug}"${body?.error ? `: ${body.error}` : ""}`;
			console.error(message);
			select.title = message;
			return null;
		}
		if (body.compatible === false) {
			console.warn(
				`Installed "${body.plugin.name}" (${body.plugin.slug}), but it targets an incompatible Tether plugin API version and won't appear in any picker until updated.`
			);
			return null;
		}
		select.title = "";
		return body.plugin;
	} catch {
		const message = `Failed to install plugin "${registrySlug}": network error`;
		console.error(message);
		select.title = message;
		return null;
	} finally {
		select.disabled = false;
	}
}

// ---------- Analytics dashboard widgets (installed widget plugins pinned to the Analytics view) ----------

interface DashboardResponse {
	slugs: string[];
}

function widgetGridSpanClass(size: string): string {
	return size === "large" ? "widget-cell-large" : size === "small" ? "widget-cell-small" : "widget-cell-medium";
}

function buildWidgetCard(slug: string, name: string, entry: string, size: string, onRemove: (slug: string) => void): HTMLElement {
	const card = document.createElement("div") as HTMLDivElement;
	card.className = `widget-card ${widgetGridSpanClass(size)}`;
	const head = document.createElement("div") as HTMLDivElement;
	head.className = "widget-card-head";
	head.textContent = name;
	const removeBtn = document.createElement("button") as HTMLButtonElement;
	removeBtn.setAttribute("type", "button");
	removeBtn.className = "widget-remove";
	removeBtn.setAttribute("aria-label", `Remove ${name}`);
	removeBtn.textContent = "×";
	removeBtn.addEventListener("click", () => onRemove(slug));
	head.appendChild(removeBtn);
	const iframe = document.createElement("iframe") as HTMLIFrameElement;
	iframe.className = "widget-frame";
	iframe.setAttribute("sandbox", "allow-scripts allow-same-origin");
	iframe.src = `/plugins/${encodeURIComponent(slug)}/${entry}`;
	card.appendChild(head);
	card.appendChild(iframe);
	return card;
}

async function saveDashboardSlugs(slugs: string[]): Promise<void> {
	try {
		await window.fetch("/api/v1/dashboard/analytics", {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ slugs }),
		});
	} catch {
		// Best-effort -- the in-memory grid is still correct even if the save failed; the next
		// page load falls back to whatever was last persisted successfully.
	}
}

async function initWidgetDashboard(): Promise<void> {
	const gridEl = document.getElementById("widgetGrid") as HTMLDivElement | null;
	const picker = document.getElementById("addWidgetPicker") as HTMLSelectElement | null;
	if (!gridEl || !picker || !picker.options) return;
	// Rebind to a variable TypeScript can prove is non-null inside the addWidget closure below --
	// control-flow narrowing from the guard above doesn't persist into a nested function
	// declaration, since gridEl _could_ theoretically be reassigned by the time addWidget runs
	// (it can't, being const, but the checker doesn't special-case that across closures).
	const grid = gridEl;

	const optionsBySlug = new Map<string, HTMLOptionElement>();
	Array.from(picker.options).forEach((o) => {
		if (o.value) optionsBySlug.set(o.value, o);
	});
	const cardsBySlug = new Map<string, HTMLElement>();

	function removeWidget(slug: string): void {
		const card = cardsBySlug.get(slug);
		if (card) {
			card.remove();
			cardsBySlug.delete(slug);
		}
		const option = optionsBySlug.get(slug);
		if (option) option.hidden = false;
		saveDashboardSlugs(Array.from(cardsBySlug.keys()));
	}

	function addWidget(slug: string): boolean {
		if (cardsBySlug.has(slug)) return false;
		const option = optionsBySlug.get(slug);
		if (!option) return false; // stale/uninstalled -- silently skip, matches the server's own skip convention
		const entry = option.getAttribute("data-entry") ?? "";
		const size = option.getAttribute("data-size") ?? "medium";
		const card = buildWidgetCard(slug, option.textContent ?? slug, entry, size, removeWidget);
		grid.appendChild(card);
		cardsBySlug.set(slug, card);
		option.hidden = true;
		return true;
	}

	let persisted: string[] = [];
	try {
		const res = await window.fetch("/api/v1/dashboard/analytics");
		if (res.ok) persisted = ((await res.json()) as DashboardResponse).slugs;
	} catch {
		persisted = [];
	}
	persisted.forEach(addWidget);

	// This picker is a stateless "Add widget…" control -- unlike the panel pickers, it never
	// reflects a single "currently mounted" choice, so its own previous value is always "" (it's
	// reset back to "" after every change, success or failure). Tracked explicitly anyway, the same
	// way onPluginPickerChange's mountedPluginValue is, so a failed install restores an actual
	// captured previous value rather than a hardcoded "" -- if this control's reset behavior ever
	// changes, this keeps working instead of silently becoming wrong.
	let previousPickerValue = "";

	picker.addEventListener("change", () => {
		const raw = picker.value;
		if (raw === "") return;
		const capturedPreviousValue = previousPickerValue;
		if (raw.startsWith("registry:")) {
			const registrySlug = raw.slice("registry:".length);
			const option = optionsBySlug.get(raw);
			return installFromRegistry(picker, registrySlug).then((plugin) => {
				if (!plugin || !option) { picker.value = capturedPreviousValue; return; }
				option.value = plugin.slug;
				option.textContent = plugin.name;
				option.setAttribute("data-entry", plugin.entry);
				option.setAttribute("data-size", plugin.size ?? "medium");
				optionsBySlug.delete(raw);
				optionsBySlug.set(plugin.slug, option);
				if (addWidget(plugin.slug)) saveDashboardSlugs(Array.from(cardsBySlug.keys()));
				picker.value = previousPickerValue = "";
			});
		}
		if (addWidget(raw)) saveDashboardSlugs(Array.from(cardsBySlug.keys()));
		picker.value = previousPickerValue = "";
	});
}

// Invariant that must hold on both this client-updated version and shell.ts's topbar()'s
// server-rendered version: no `href` attribute on the Harness tab iff aria-disabled="true".
// onRailOrTabClick's disabled check and any code doing `new URL(anchor.href)` on this tab depend
// on that equivalence holding in both places.
function updateHarnessTab(traceId: string | null): void {
	const tab = document.querySelector('[data-nav="harness"]');
	if (!tab) return;
	if (traceId) {
		tab.setAttribute("href", `/runs/${encodeURIComponent(traceId)}/harness`);
		tab.classList.remove("tab-disabled");
		tab.removeAttribute("aria-disabled");
	} else {
		tab.removeAttribute("href");
		tab.classList.add("tab-disabled");
		tab.setAttribute("aria-disabled", "true");
	}
}

/** Mounts the embedded #run-data island if present, returning the traceId it actually mounted --
 * or null if there was none (empty-store panel) or no #run-data at all. The caller (navigateTo)
 * needs this back because /fragments/detail (no traceId in the URL) resolves server-side to
 * "whichever run is most recent," which the client can't know in advance (see I2). */
function mountRunDataIfPresent(): string | null {
	const dataEl = document.getElementById("run-data");
	if (!dataEl) return null;
	// RunData is the type mountDetailPanel (Task 6, same module) already declares.
	const runData = JSON.parse(dataEl.textContent || "null") as RunData | null;
	if (!runData) return null;
	currentUnmount = mountDetailPanel(runData);
	document.title = `Tether — ${runData.goal}`;
	return runData.traceId;
}

function fmtTimestamp(ts: string): string {
	if (!ts) return "unknown time";
	const d = new Date(ts);
	return Number.isNaN(d.getTime()) ? "unknown time" : d.toLocaleString();
}

/**
 * One attached entry (file read, skill/sub-agent/MCP-server discovery, injected context, ...)
 * as a small card. `nameOrPath`, `source`, `sessionId`, and `contentPreview` are all
 * attacker/agent-controlled (same trust level as everything else rendered in this file, per
 * escapeHtml's existing uses above) -- every one of them goes through escapeHtml. A
 * `hook_injected_context` entry typically has no meaningful nameOrPath, so that (and any other
 * kind with an empty one) falls back to a placeholder rather than rendering blank.
 * contentPreview can be up to ~16KB (the server's sanitize cap) -- wrapped in a closed
 * `<details>` (same collapsible pattern renderMessages above already uses for message bodies)
 * so a page with many preview-heavy entries doesn't render megabytes of visible text at once;
 * .io-block's existing overflow-x/pre-wrap styling keeps even a single huge line from blowing
 * out the layout once expanded.
 */
function renderCompositionEntry(e: CompositionEntry): string {
	const label = e.nameOrPath || (e.kind === "hook_injected_context" ? "(injected context)" : "(unnamed)");
	const sessionLabel = e.sessionId ? escapeHtml(e.sessionId) : "no session id";
	const metaBits = [escapeHtml(e.source || "unknown source"), fmtTimestamp(e.timestamp), "session " + sessionLabel];
	if (e.sizeBytes) metaBits.push(fmtBytes(e.sizeBytes));
	const preview = e.contentPreview
		? '<details class="msg-row"><summary class="msg-role">Preview (' + fmtBytes(e.contentPreview.length) + ")</summary>"
			+ '<div class="io-block">' + escapeHtml(e.contentPreview) + "</div></details>"
		: "";
	return '<div class="insp-section">'
		+ '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">'
		+ '<span class="stat-chip" style="color:var(--ink-3);background:var(--panel-2)">' + escapeHtml(e.kind) + "</span>"
		+ "<strong>" + escapeHtml(label) + "</strong>"
		+ "</div>"
		+ '<div class="io-kind" style="margin-top:6px;text-transform:none;letter-spacing:normal">' + metaBits.join(" · ") + "</div>"
		+ preview
		+ "</div>";
}

function renderCompositionEntries(entries: CompositionEntry[]): string {
	if (!entries.length) return '<div class="insp-empty">No composition data for this session.</div>';
	return entries.map(renderCompositionEntry).join("");
}

/** Mounts the embedded #composition-data island if present, returning the traceId it mounted --
 * or null if there was none. navigateTo tries mountRunDataIfPresent first (a fragment only ever
 * carries one island or the other, see composition-detail.ts/flight-recorder.ts), so this only
 * ever does anything on the composition-only ("not linked to a run" -- includes but isn't limited
 * to a crashed/background session) fragment from Task 3. Unlike mountDetailPanel, this view has
 * no timers/listeners of its own, so it doesn't set currentUnmount -- the caller's existing
 * `if (currentUnmount) { ... }` guard
 * already cleans up whatever the *previous* panel left behind. */
function mountCompositionDataIfPresent(): string | null {
	const dataEl = document.getElementById("composition-data");
	if (!dataEl) return null;
	const data = JSON.parse(dataEl.textContent || "null") as CompositionData | null;
	if (!data) return null;
	const count = data.entries.length;
	const label = count + " item" + (count === 1 ? "" : "s");
	$("composition-mission").textContent = `Session ${data.traceId} — composition data (not linked to a run), ${label} attached`;
	$("compositionCount").textContent = label;
	$("compositionEntries").innerHTML = renderCompositionEntries(data.entries);
	document.title = `Tether — Composition (${label})`;
	return data.traceId;
}

function renderRetry(retry: () => void): void {
	const content = $("content");
	content.innerHTML = `<p class="empty">Couldn't load this view. <button id="retryNav" type="button">Retry</button></p>`;
	document.getElementById("retryNav")?.addEventListener("click", retry);
}

async function navigateTo(pathname: string, push: boolean): Promise<void> {
	const target = parsePathname(pathname);
	if (!target) { window.location.href = pathname; return; }

	// I4: claim this navigation's token before the first await. Since every navigateTo call
	// increments navSeq synchronously before it ever yields, the final value of navSeq by the time
	// any call resumes is already whatever the LAST call to start set it to -- so this comparison
	// is race-proof regardless of the order the two fetches actually resolve in.
	const seq = ++navSeq;

	let html: string;
	let status: number;
	try {
		const res = await window.fetch(fragmentUrlFor(target));
		if (seq !== navSeq) return; // a newer navigation started while this fetch was in flight
		status = res.status;
		html = await res.text();
		if (seq !== navSeq) return; // ditto, after the body read
	} catch {
		if (seq !== navSeq) return;
		renderRetry(() => navigateTo(pathname, push));
		return;
	}
	if (status !== 200 && status !== 404) {
		renderRetry(() => navigateTo(pathname, push));
		return;
	}

	if (currentUnmount) { currentUnmount(); currentUnmount = null; }
	$("content").innerHTML = html;

	// The traceId the fetched fragment actually resolved to. Usually just target.traceId, except
	// for target.view === "detail" && target.traceId === null (i.e. pathname "/"), where the
	// server picked "most recent run" and the client only learns which run that was from the
	// #run-data island just mounted (I2).
	let resolvedTraceId = target.traceId;

	if (status === 404) {
		document.title = "Tether — Run not found";
	} else if (target.view === "detail") {
		resolvedTraceId = mountRunDataIfPresent() ?? mountCompositionDataIfPresent() ?? target.traceId;
	} else if (target.view === "harness") {
		document.title = "Tether — Harness";
		mountHarnessIfPresent();
	} else {
		document.title = "Tether — Analytics";
		void initWidgetDashboard();
	}

	currentState = target.view === "detail" ? { view: "detail", traceId: resolvedTraceId } : target;

	setTabActive(target.view);
	setRailActive(target.view === "analytics" ? null : resolvedTraceId);
	updateHarnessTab(target.view === "analytics" ? null : resolvedTraceId);
	setPluginPickerVisibility(target.view);
	if (push) window.history.pushState(null, "", pathname);
}

function onRailOrTabClick(e: MouseEvent): void {
	const targetEl = e.target as Element | null;
	const anchor = targetEl?.closest("a[data-trace-id], a[data-nav]");
	if (!anchor) return;
	if (anchor.getAttribute("aria-disabled") === "true") return;
	if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
	e.preventDefault();
	navigateTo(new URL((anchor as HTMLAnchorElement).href).pathname, true);
}

function onPopState(): void {
	navigateTo(window.location.pathname, false);
}

function pollRail(): void {
	const query = currentState.traceId ? `?active=${encodeURIComponent(currentState.traceId)}` : "";
	window.fetch(`/fragments/rail${query}`)
		.then((res) => (res.ok ? res.text() : null))
		.then((html) => { if (html != null) $("rail").innerHTML = html; })
		.catch(() => {});
}

function initThemeToggle(): void {
	document.getElementById("themeBtn")?.addEventListener("click", () => {
		const root = document.documentElement;
		const isDark = (root.getAttribute("data-theme") || (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")) === "dark";
		root.setAttribute("data-theme", isDark ? "light" : "dark");
	});
}

function init(): void {
	const initial = (window as WindowWithInitialState).__TETHER_INITIAL__;
	if (initial) currentState = initial;

	document.getElementById("rail")?.addEventListener("click", onRailOrTabClick);
	document.querySelector<HTMLElement>(".tabbar")?.addEventListener("click", onRailOrTabClick);
	window.addEventListener("popstate", onPopState);
	initThemeToggle();
	window.setInterval(pollRail, 5000);
	(Object.keys(PLUGIN_PICKER_IDS) as Array<ShellState["view"]>).forEach((slot) => {
		document.getElementById(PLUGIN_PICKER_IDS[slot])?.addEventListener("change", () => onPluginPickerChange(slot));
	});

	// Same fallback order as navigateTo's detail branch: a server-rendered full-page load of a
	// composition-only session's URL (direct nav, refresh, bookmark) embeds #composition-data
	// instead of #run-data, and needs the same client-side mount to actually show its entries --
	// this is the one hydration path navigateTo's fetch-based branch never runs for.
	if (currentState.view === "detail") mountRunDataIfPresent() ?? mountCompositionDataIfPresent();
	if (currentState.view === "harness") mountHarnessIfPresent();
	if (currentState.view === "analytics") void initWidgetDashboard();
	setPluginPickerVisibility(currentState.view);
}

init();
