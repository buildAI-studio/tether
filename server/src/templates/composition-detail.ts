import type { CompositionView } from "../composition.js";

/**
 * The composition-only Detail panel's static DOM skeleton -- shown instead of
 * flight-recorder.ts's SKELETON when a traceId has no root span (no completed
 * `trail_finish_run`) but does have `trail_attach` composition data. Much
 * simpler than the run skeleton: no timeline/transport/steps, since there's
 * no run to scrub through, just a flat list of attached entries.
 */
const SKELETON = `
<section class="mission" id="composition-mission"></section>
<section class="panel">
	<div class="panel-head"><h2>Attached</h2><span class="count" id="compositionCount"></span></div>
	<div class="insp" id="compositionEntries"></div>
</section>
`;

/**
 * The composition-only Detail panel's initial content: the static skeleton
 * plus the traceId and composition entries as an inert `type="application/json"`
 * script tag -- same convention as flight-recorder.ts's renderDetailFragment:
 * never executed as JS by the browser, read via textContent + JSON.parse, `<`
 * escaped so a nameOrPath/contentPreview containing a literal "</script>"-like
 * substring can't end this tag early at the HTML-parser level.
 */
export function renderCompositionFragment(traceId: string, view: CompositionView): string {
	const json = JSON.stringify({ traceId, ...view }).replace(/</g, "\\u003c");
	return `${SKELETON}
<script type="application/json" id="composition-data">${json}</script>`;
}
