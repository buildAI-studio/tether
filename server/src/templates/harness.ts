import type { HarnessView } from "../harness.js";
import type { CoverageView } from "../coverage.js";

function escapeHtml(s: string): string {
	return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}

const ICON_ZOOM_OUT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M5 12h14"/></svg>';
const ICON_ZOOM_IN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>';
const ICON_ZOOM_FIT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>';

/** The harness panel's body for one run. The caller (server.ts) guarantees `view` is non-null --
 * an unknown traceId is handled generically via shell.ts's renderNotFoundPanel, not here.
 *
 * Renders only a skeleton (toolbar + empty `<svg>` canvas) plus a `#harness-data` JSON island --
 * app.ts's mountHarnessPanel lays the skills/sub-agents/MCP-server entries out as a grouped
 * node-link map (ELK.js, vendored, see static/vendor/elk.bundled.js) and draws the actual cards
 * client-side, the same division of labor flight-recorder.ts's `#run-data` island already uses
 * for the Detail panel. `coverage` feeds each card's used/not-used dot; it's optional (null when
 * the caller has none available) since not every route that can render this panel also computes
 * coverage, unlike the harness view itself which always exists once a run does. */
export function renderHarnessBody(view: HarnessView, coverage: CoverageView | null = null): string {
	const header = `<p class="as-of">Harness as of: <strong>${escapeHtml(view.goal)}</strong> · ${escapeHtml(view.startedAt)}</p>`;
	const total = view.skills.length + view.subAgents.length + view.mcpServers.length;
	if (total === 0) {
		return `${header}<p class="empty">No skills, sub-agents, or MCP servers discovered for this run.</p>`;
	}

	// `<` is escaped the same way shell.ts's bootstrap script and flight-recorder.ts's `#run-data`
	// island already do -- an attacker-controlled skill/sub-agent/tool name containing "</script>"
	// must not be able to close this element early.
	const json = JSON.stringify({ harness: view, coverage }).replace(/</g, "\\u003c");

	return `${header}
<div class="harness-graph-wrap" id="harnessGraphWrap">
	<div class="harness-toolbar">
		<button type="button" class="iconbtn" id="hGraphZoomOut" title="Zoom out" aria-label="Zoom out">${ICON_ZOOM_OUT}</button>
		<button type="button" class="iconbtn" id="hGraphZoomFit" title="Fit to screen" aria-label="Fit to screen">${ICON_ZOOM_FIT}</button>
		<button type="button" class="iconbtn" id="hGraphZoomIn" title="Zoom in" aria-label="Zoom in">${ICON_ZOOM_IN}</button>
	</div>
	<svg id="hGraphSvg" class="harness-svg" xmlns="http://www.w3.org/2000/svg"><g id="hGraphViewport"></g></svg>
</div>
<script type="application/json" id="harness-data">${json}</script>`;
}
