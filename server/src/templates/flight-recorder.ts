import type { RunView } from "../runs.js";
import type { CoverageView } from "../coverage.js";
import type { CompositionView } from "../composition.js";

/**
 * The Detail panel's static DOM skeleton -- element ids match exactly what
 * server/src/static/app.ts's mountDetailPanel expects to find via document.getElementById.
 * No <style> (moved to shell.ts's shared stylesheet) and no <script> (the interactive
 * rendering logic moved to app.ts, loaded once by the shell instead of once per page).
 */
const SKELETON = `
<section class="mission" id="mission"></section>

<section class="trail-card">
	<div class="transport">
		<button class="play-btn" id="playBtn" aria-label="Play replay">
			<svg id="playIcon" viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
		</button>
		<div class="clock"><span id="clockNow">0:00</span><span class="sep"> / </span><span id="clockTot">0:00</span></div>
		<div class="speeds" id="speeds" role="group" aria-label="Playback speed">
			<button data-sp="1" aria-pressed="true">1&times;</button>
			<button data-sp="2" aria-pressed="false">2&times;</button>
			<button data-sp="4" aria-pressed="false">4&times;</button>
		</div>
		<div class="live-accrue">
			<div class="accrue"><span class="k">Cost so far</span><span class="v" id="accCost">$0.00</span></div>
			<div class="accrue"><span class="k">Steps</span><span class="v" id="accSteps">0</span></div>
			<div class="accrue"><span class="k">Tokens</span><span class="v" id="accTok">0</span></div>
		</div>
	</div>
	<div class="strip-shell">
		<div class="strip" id="strip" role="slider" aria-label="Scrub run timeline" tabindex="0" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">
			<svg class="cost-area" id="costArea" preserveAspectRatio="none" aria-hidden="true"></svg>
			<div class="playhead" id="playhead" style="left:0%"></div>
		</div>
		<div class="signals" id="signals"><span class="sig-cap">retries</span></div>
		<div class="axis"><span>t = 0s</span><span id="axisEnd">end</span></div>
	</div>
</section>

<section class="split">
	<div class="panel">
		<div class="panel-head">
			<h2>Steps</h2>
			<span class="count" id="stepCount"></span>
		</div>
		<div class="steps" id="steps"></div>
	</div>
	<div class="panel">
		<div class="panel-head"><h2 id="inspTitle">Verdict</h2></div>
		<div class="insp" id="insp"></div>
	</div>
</section>

<section class="panel">
	<div class="panel-head"><h2>Coverage</h2></div>
	<div class="insp" id="coverage"></div>
</section>

<section class="panel">
	<div class="panel-head"><h2>Attached</h2></div>
	<div class="insp" id="compositionEntries"></div>
</section>
`;

/**
 * The Detail panel's initial content: the static skeleton plus the run's data as an inert
 * `type="application/json"` script tag -- never executed as JS by the browser (by spec, whether
 * present at initial load or inserted later via innerHTML), read via textContent + JSON.parse by
 * app.ts's mountDetailPanel instead. `<` is still escaped so a goal containing a literal
 * "</script>" can't end this tag early at the HTML-parser level -- that risk is independent of the
 * tag's type attribute. The old U+2028/U+2029 line-terminator escaping is dropped: it only mattered
 * when this JSON was substituted directly into JS source (`const RUN = ...`) and eval'd; both
 * characters are valid inside a JSON string and inside a <script> tag's text content, so
 * JSON.parse(textContent) needs no help with them. `composition` is non-null only when the run's
 * session is linked to one (see composition.ts's getCompositionViewForSessionId) -- the "Attached"
 * section above renders from it, same island, same escaping, no separate script tag.
 */
export function renderDetailFragment(run: RunView, coverage: CoverageView | null, composition: CompositionView | null): string {
	const json = JSON.stringify({ ...run, coverage, composition }).replace(/</g, "\\u003c");
	return `${SKELETON}
<script type="application/json" id="run-data">${json}</script>`;
}

/** Shown in the Detail panel when the store has no runs at all (only reachable at `/`). */
export function renderEmptyDetailPanel(): string {
	return `<p class="empty">No runs yet. Point a coding agent at this Tether instance and run something.</p>`;
}
