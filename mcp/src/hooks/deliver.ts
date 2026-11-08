/**
 * Converts locally-captured AttachmentEntry records into OTLP spans under
 * the gen_ai.harness.attachment.* namespace, so Tether's server can ingest
 * composition data the same way it ingests every other span (pure
 * functions, no network I/O), and best-effort delivers those spans to
 * Tether's server (local or Trail Cloud).
 *
 * deliverBestEffort is called synchronously inside Claude Code's own
 * PreToolUse/SessionStart/UserPromptExpansion hook loop, so it must never
 * throw/reject and must never block past its own timeout budget per entry
 * -- an unreachable or black-holed TRAIL_URL must not stall or crash the
 * session. The actual hook CLI entry point (mcp/src/index.ts) additionally
 * calls process.exit(0) right after the hook subcommand returns, which is
 * what guarantees the process itself can't be held open by a still-pending
 * fetch socket underneath sendSpan even in the rare case this module's own
 * timeout race didn't fully unwind the network call.
 */

import { createHash } from "node:crypto";
import type { SpanInput, TrailConfig } from "../otlp.js";
import { hexId, nowNanos, sendSpan } from "../otlp.js";
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

/** Mirrors mcp/src/index.ts's config construction exactly. */
export function configFromEnv(): TrailConfig {
	return {
		url: process.env.TRAIL_URL ?? "http://127.0.0.1:4319",
		publicKey: process.env.TRAIL_PUBLIC_KEY,
		secretKey: process.env.TRAIL_SECRET_KEY,
		environment: process.env.TRAIL_ENV ?? "default",
		serviceName: process.env.TRAIL_APP ?? "coding-agent",
	};
}

/**
 * Races one sendSpan call against a timeout. The timeout promise is what
 * bounds how long this function's own await can take; it does NOT cancel
 * sendSpan's underlying fetch (otlp.ts's sendSpan takes no AbortSignal and
 * is deliberately left unmodified), so a still-pending connection can keep
 * running in the background after this resolves. That's acceptable here
 * because the only caller that matters for the safety guarantee (the hook
 * CLI subcommand) calls process.exit(0) immediately after, which tears
 * down any such dangling socket regardless. The local `timer` handle
 * itself is always cleared, so at least this function leaves no timer
 * behind on either path.
 */
async function sendWithTimeout(cfg: TrailConfig, span: SpanInput, timeoutMs: number): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
	});
	try {
		await Promise.race([sendSpan(cfg, span), timeout]);
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Best-effort delivery of locally-captured attachment entries to Tether's
 * server. Never throws, never rejects -- every failure (per-entry timeout,
 * network error, non-2xx response) is swallowed so one bad entry or one
 * unreachable server can't stop the rest of the entries from being
 * attempted, and can't propagate past this function at all.
 */
export async function deliverBestEffort(
	cfg: TrailConfig,
	entries: AttachmentEntry[],
	timeoutMs = 2000,
): Promise<void> {
	try {
		for (const entry of entries) {
			try {
				await sendWithTimeout(cfg, buildAttachmentSpan(entry), timeoutMs);
			} catch {
				// best-effort: one entry's failure must not stop the rest.
			}
		}
	} catch {
		// best-effort: discard any delivery failure entirely.
	}
}
