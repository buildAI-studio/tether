/**
 * Orchestrates Tasks 1–3 for a single hook invocation: parse the hook's
 * stdin JSON payload, derive AttachmentEntry records from both the direct
 * payload fields and any newly-appended transcript attachment records, and
 * persist them to the local composition log.
 *
 * Safety contract: this is invoked as a Claude Code hook. PreToolUse's
 * stdout can be read as JSON that alters the agent's own permission flow,
 * and SessionStart's stdout is injected as context -- so `runHook` must
 * NEVER throw and must NEVER write to stdout under any circumstance,
 * including malformed stdin or a thrown error from any dependency. The
 * entire body below is one try/catch specifically to guarantee that.
 */

import { fromPreToolUse, fromUserPromptExpansion, fromTranscriptAttachment } from "./capture.js";
import type { AttachmentEntry } from "./capture.js";
import { scanTranscriptForAttachments } from "./transcript.js";
import { resolveLogDir, readOffset, writeOffset, appendEntries } from "./log.js";

export async function runHook(eventArg: string, stdinText: string): Promise<void> {
	try {
		let payload: Record<string, unknown>;
		try {
			const parsed = JSON.parse(stdinText);
			if (parsed === null || typeof parsed !== "object") return;
			payload = parsed as Record<string, unknown>;
		} catch {
			return; // malformed stdin -- nothing to do
		}

		const sessionId = typeof payload.session_id === "string" ? payload.session_id : "";

		let directEntries: AttachmentEntry[] = [];
		if (eventArg === "pre-tool-use") {
			directEntries = fromPreToolUse(payload);
		} else if (eventArg === "user-prompt-expansion") {
			directEntries = fromUserPromptExpansion(payload);
		}
		// session-start / stop: no direct-field entries.

		const transcriptPath = payload.transcript_path;
		let transcriptEntries: AttachmentEntry[] = [];
		let logDir: string | undefined;
		let newOffset: number | undefined;
		if (typeof transcriptPath === "string") {
			logDir = resolveLogDir(payload);
			const offset = readOffset(logDir, sessionId, transcriptPath);
			const scanResult = scanTranscriptForAttachments(transcriptPath, offset);
			transcriptEntries = scanResult.attachments.map((att) => fromTranscriptAttachment(att, sessionId));
			newOffset = scanResult.newOffset;
		}

		const entries = [...directEntries, ...transcriptEntries];
		logDir ??= resolveLogDir(payload);
		appendEntries(logDir, entries); // no-op when entries is empty

		// Persist the new offset only after the entries it unlocks are safely
		// on disk -- otherwise a failure in appendEntries would lose those
		// transcript-derived entries for good (the offset would already have
		// moved past them). Writing the offset after a failed append instead
		// just re-reads the same transcript lines next time, which is safe.
		if (typeof transcriptPath === "string" && newOffset !== undefined) {
			writeOffset(logDir, sessionId, transcriptPath, newOffset);
		}
	} catch {
		// never throw -- a hook crash or bad stdout would corrupt Claude Code's
		// own hook-driven permission/context flow.
	}
}
