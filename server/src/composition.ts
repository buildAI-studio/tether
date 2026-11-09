/**
 * Reads a trace's `gen_ai.harness.attachment.*` spans straight out of the
 * `spans` table by traceId, deliberately *not* going through
 * runs.ts's getRun/listRuns (both root-span-gated via `parentSpanId IS
 * NULL`, which only a completed `trail_finish_run` call produces). A
 * crashed or still-running session never gets that root span, so this view
 * is the only way its composition data is ever visible.
 */

import type Database from "better-sqlite3";
import { parseRaw, asString, toIsoOrEmpty, toNs } from "./runs.js";

export interface CompositionEntry {
	source: string;
	kind: string;
	nameOrPath: string;
	sizeBytes: number;
	contentPreview?: string;
	sessionId: string;
	timestamp: string;
}

export interface CompositionView {
	entries: CompositionEntry[];
}

interface StoredRow {
	traceId: string;
	spanId: string;
	parentSpanId: string | null;
	name: string;
	startTimeUnixNano: string;
	endTimeUnixNano: string;
	raw: string;
}

/**
 * Reshapes one trace's stored attachment spans into a CompositionView.
 * Returns null only when the traceId has no spans at all; a traceId whose
 * spans exist but carry no attachment attributes returns `{ entries: [] }`
 * -- the two are distinguishable (unknown trace vs. no composition data).
 */
export function getCompositionView(db: Database.Database, traceId: string): CompositionView | null {
	const rows = db
		.prepare("SELECT traceId, spanId, parentSpanId, name, startTimeUnixNano, endTimeUnixNano, raw FROM spans WHERE traceId = ? ORDER BY startTimeUnixNano ASC")
		.all(traceId) as StoredRow[];

	if (rows.length === 0) return null;

	const entries: CompositionEntry[] = [];
	for (const row of rows) {
		const parsed = parseRaw(row.raw);
		if (!parsed) continue;
		const kind = asString(parsed.attrs["gen_ai.harness.attachment.kind"]);
		if (!kind) continue; // not an attachment span (unauthenticated ingest -- treat as "not ours" rather than throw)

		const contentPreview = asString(parsed.attrs["gen_ai.harness.attachment.content_preview"]);
		// row.startTimeUnixNano arrives from unauthenticated ingest with zero format validation --
		// toNs degrades a malformed value to null (rather than BigInt() throwing a SyntaxError) so one
		// bad span can't crash the whole view, matching toIsoOrEmpty's own out-of-range-value-to-""
		// convention.
		const startNs = toNs(row.startTimeUnixNano);
		entries.push({
			source: asString(parsed.attrs["gen_ai.harness.attachment.source"]) ?? "",
			kind,
			nameOrPath: asString(parsed.attrs["gen_ai.harness.attachment.name_or_path"]) ?? "",
			sizeBytes: typeof parsed.attrs["gen_ai.harness.attachment.size_bytes"] === "number" ? (parsed.attrs["gen_ai.harness.attachment.size_bytes"] as number) : 0,
			...(contentPreview !== undefined ? { contentPreview } : {}),
			sessionId: asString(parsed.attrs["gen_ai.harness.attachment.session_id"]) ?? "",
			timestamp: startNs !== null ? toIsoOrEmpty(startNs) : "",
		});
	}

	return { entries };
}

export interface CompositionSessionSummary {
	traceId: string;
	sessionId: string;
	entryCount: number;
	lastActivityAt: string;
}

interface CandidateRow {
	traceId: string;
	lastNs: string;
}

/**
 * Finds traces that have composition data but never got a root span -- i.e. sessions that
 * crashed or are still running under `trail_attach` with no corresponding `trail_finish_run`.
 * A crashed *self-reported* run (real step data under gen_ai.harness.source_type, also
 * rootless) is excluded too: it has no attachment attributes, so getCompositionView returns
 * `{ entries: [] }` for it and this function skips it below.
 */
export function listCompositionOnlySessions(db: Database.Database, limit: number): CompositionSessionSummary[] {
	const candidates = db
		.prepare(
			"SELECT traceId, MAX(startTimeUnixNano) as lastNs FROM spans WHERE traceId NOT IN (SELECT traceId FROM spans WHERE parentSpanId IS NULL) GROUP BY traceId ORDER BY lastNs DESC LIMIT ?",
		)
		.all(limit) as CandidateRow[];

	const summaries: CompositionSessionSummary[] = [];
	for (const row of candidates) {
		const view = getCompositionView(db, row.traceId);
		if (!view || view.entries.length === 0) continue; // no attachment data -- a crashed self-reported run, or no data at all

		const lastNs = toNs(row.lastNs);
		summaries.push({
			traceId: row.traceId,
			sessionId: view.entries[0].sessionId,
			entryCount: view.entries.length,
			lastActivityAt: lastNs !== null ? toIsoOrEmpty(lastNs) : "",
		});
	}

	return summaries;
}
