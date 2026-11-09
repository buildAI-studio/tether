import type { RunSummary } from "../runs.js";
import type { CompositionSessionSummary } from "../composition.js";

// Object.assign(Object.create(null), ...) rather than a plain object literal: `run.verdict` is
// attacker-controlled (arrives via the unauthenticated POST /traces endpoint), and runs.ts's
// asVerdict() is the primary guard against a poisoned value like "__proto__" or "constructor"
// reaching here at all -- but a null-prototype lookup table means even a value that somehow
// bypassed that boundary resolves via `??`/`hasOwnProperty` semantics instead of walking the
// prototype chain to a function or Object.prototype, which would crash escapeHtml() below.
const VERDICT_COLOR: Record<string, string> = Object.assign(Object.create(null), { met: "#2FA24A", partial: "#C08810", failed: "#DC4A38", unjudged: "#8A8F97" });
const VERDICT_LABEL: Record<string, string> = Object.assign(Object.create(null), { met: "Goal met", partial: "Partial", failed: "Goal missed", unjudged: "Not judged" });

function escapeHtml(s: string): string {
	return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** "5m ago" / "3h ago" / "3d ago" / a plain YYYY-MM-DD date for anything older than 30 days or in
 * the future (clock skew shouldn't ever show a negative duration). Never throws -- a malformed
 * ISO string returns itself unchanged, matching this codebase's degrade-gracefully convention. */
export function formatRelativeTime(startedAtIso: string, nowMs: number): string {
	const t = Date.parse(startedAtIso);
	if (Number.isNaN(t)) return startedAtIso;
	const diff = nowMs - t;
	if (diff < 0) return startedAtIso.slice(0, 10);
	if (diff < MINUTE_MS) return "just now";
	if (diff < HOUR_MS) return `${Math.floor(diff / MINUTE_MS)}m ago`;
	if (diff < DAY_MS) return `${Math.floor(diff / HOUR_MS)}h ago`;
	if (diff < 30 * DAY_MS) return `${Math.floor(diff / DAY_MS)}d ago`;
	return startedAtIso.slice(0, 10);
}

function railRow(run: RunSummary, activeTraceId: string | undefined, nowMs: number): string {
	const color = VERDICT_COLOR[run.verdict] ?? VERDICT_COLOR.unjudged;
	const label = VERDICT_LABEL[run.verdict] ?? "Not judged";
	const activeClass = run.traceId === activeTraceId ? " rail-row-active" : "";
	return `<a class="rail-row${activeClass}" href="/runs/${escapeHtml(run.traceId)}" data-trace-id="${escapeHtml(run.traceId)}">
		<span class="rail-dot-goal"><span class="rail-dot" style="background:${color}" title="${escapeHtml(label)}"></span><span class="rail-goal">${escapeHtml(run.goal)}</span></span>
		<span class="rail-time">${escapeHtml(formatRelativeTime(run.startedAt, nowMs))}</span>
	</a>`;
}

/** A session the `trailai-mcp` hooks captured composition data for (skills/files attached,
 * context silently injected) but that isn't linked to any completed run -- composition traceIds
 * are derived from the Claude Code session id, while a run's traceId is an unrelated random value
 * (see `mcp/src/hooks/deliver.ts`'s `traceIdFromSessionId`), so this is the common case, not an
 * error case: it covers every ordinary session alongside crashed/background ones that never
 * produced a run at all. `listCompositionOnlySessions` (composition.ts) surfaces these. Renders a
 * badge instead of a verdict dot, and a `Session <id prefix>` label instead of a goal, so it reads
 * as distinct from -- not a 5th verdict state of -- a normal run row. */
function compositionRow(session: CompositionSessionSummary, activeTraceId: string | undefined, nowMs: number): string {
	const activeClass = session.traceId === activeTraceId ? " rail-row-active" : "";
	const label = session.sessionId ? `Session ${session.sessionId.slice(0, 8)}` : "Unknown session";
	return `<a class="rail-row rail-row-composition${activeClass}" href="/runs/${escapeHtml(session.traceId)}" data-trace-id="${escapeHtml(session.traceId)}">
		<span class="rail-dot-goal"><span class="rail-badge-composition" title="Not linked to a run">session</span><span class="rail-goal">${escapeHtml(label)}</span></span>
		<span class="rail-time">${escapeHtml(formatRelativeTime(session.lastActivityAt, nowMs))}</span>
	</a>`;
}

/** A row the rail can render: a completed run, or a composition-only session with no completed
 * run at all. See Task 2's brief (and composition.ts's listCompositionOnlySessions) for why the
 * latter needs its own entry kind rather than being shoehorned into RunSummary. */
export type RailEntry = { kind: "run"; run: RunSummary } | { kind: "composition"; session: CompositionSessionSummary };

/** The inner HTML of the shell's `<nav id="rail">` -- never the `<nav>` wrapper itself, since the
 * client router replaces just this element's innerHTML on each rail poll (see app.ts). */
export function renderRailBody(entries: RailEntry[], activeTraceId: string | undefined, nowMs: number): string {
	if (entries.length === 0) return `<p class="rail-empty">No runs yet.</p>`;
	return entries.map((e) => (e.kind === "run" ? railRow(e.run, activeTraceId, nowMs) : compositionRow(e.session, activeTraceId, nowMs))).join("");
}
