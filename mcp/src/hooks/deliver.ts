/**
 * Converts locally-captured AttachmentEntry records into OTLP spans under
 * the gen_ai.harness.attachment.* namespace, so Tether's server can ingest
 * composition data the same way it ingests every other span. Pure
 * functions only -- no network I/O; a later task owns the actual delivery
 * call that uses buildAttachmentSpan's output.
 */

import { createHash } from "node:crypto";
import type { SpanInput } from "../otlp.js";
import { hexId, nowNanos } from "../otlp.js";
import type { AttachmentEntry } from "./capture.js";

/**
 * Derives a traceId from a session id so all of one session's composition
 * spans land under one trace. A session UUID's 32 hex digits (dashes
 * stripped) happen to already be exactly OTLP's traceId length -- anything
 * else (empty, malformed, too short/long) falls back to a random 32-hex-char
 * id, since a session with no usable id still needs a valid, if
 * ungroupable, trace rather than a malformed one.
 */
export function traceIdFromSessionId(sessionId: string): string {
	const stripped = sessionId.replace(/[^0-9a-fA-F]/g, "").toLowerCase();
	if (stripped.length === 32) return stripped;
	return hexId(16);
}

/**
 * parentSpanId is deliberately a deterministic, non-empty placeholder
 * derived from the traceId -- never left unset. An unset parentSpanId is
 * exactly what makes a span satisfy server/src/runs.ts's listRuns query
 * (`WHERE parentSpanId IS NULL`), which would make a composition span show
 * up as a bogus "run" in Tether's existing UI.
 */
function parentSpanIdFor(traceId: string): string {
	return createHash("sha256").update(traceId).digest("hex").slice(0, 16);
}

function startEndNanos(timestamp: string): string {
	const parsed = Date.parse(timestamp);
	if (Number.isNaN(parsed)) return nowNanos();
	return (BigInt(parsed) * 1_000_000n).toString();
}

/** Builds a complete OTLP span for one locally-captured attachment entry. */
export function buildAttachmentSpan(entry: AttachmentEntry): SpanInput {
	const traceId = traceIdFromSessionId(entry.sessionId);
	const timeUnixNano = startEndNanos(entry.timestamp);

	return {
		traceId,
		spanId: hexId(8),
		parentSpanId: parentSpanIdFor(traceId),
		name: "composition_attachment",
		startTimeUnixNano: timeUnixNano,
		endTimeUnixNano: timeUnixNano,
		attributes: {
			"gen_ai.harness.attachment.source": entry.source,
			"gen_ai.harness.attachment.kind": entry.kind,
			"gen_ai.harness.attachment.name_or_path": entry.nameOrPath,
			"gen_ai.harness.attachment.size_bytes": entry.sizeBytes,
			"gen_ai.harness.attachment.session_id": entry.sessionId,
			"gen_ai.harness.attachment.content_preview": entry.contentPreview,
		},
	};
}
