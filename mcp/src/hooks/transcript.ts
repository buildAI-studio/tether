/**
 * Scans a Claude Code session transcript (a JSONL file Claude Code already
 * writes) for `type:"attachment"` records, which it emits for every hook
 * invocation regardless of which hook or event produced it. Scanning is
 * offset-based so a caller can poll the same transcript repeatedly without
 * re-reading or re-parsing lines it has already seen.
 */

import { readFileSync } from "node:fs";

export interface TranscriptAttachment {
	hookEvent: string;
	hookName: string;
	stdout: string;
	command: string;
	exitCode: number;
	durationMs: number;
	timestamp: string;
}

export interface ScanResult {
	attachments: TranscriptAttachment[];
	newOffset: number;
}

function isAttachmentRecord(value: unknown): value is {
	timestamp: string;
	attachment: {
		hookEvent: string;
		hookName: string;
		stdout: string;
		command: string;
		exitCode: number;
		durationMs: number;
	};
} {
	if (value === null || typeof value !== "object") return false;
	const record = value as Record<string, unknown>;
	if (record.type !== "attachment") return false;

	const attachment = record.attachment;
	if (attachment === null || typeof attachment !== "object") return false;
	const a = attachment as Record<string, unknown>;

	return (
		typeof a.hookEvent === "string" &&
		typeof a.hookName === "string" &&
		typeof a.stdout === "string" &&
		typeof a.command === "string" &&
		typeof a.exitCode === "number"
	);
}

/**
 * Reads `transcriptPath` as a Buffer and scans forward from `fromByteOffset`
 * for complete, newline-terminated lines, parsing any `type:"attachment"`
 * record found. A trailing line with no `\n` yet (the file may still be
 * mid-write) is left unconsumed so a later call re-reads it once it's whole.
 */
export function scanTranscriptForAttachments(transcriptPath: string, fromByteOffset: number): ScanResult {
	let buffer: Buffer;
	try {
		buffer = readFileSync(transcriptPath);
	} catch {
		return { attachments: [], newOffset: fromByteOffset };
	}

	const attachments: TranscriptAttachment[] = [];
	let lineStart = fromByteOffset;
	let consumedThrough = fromByteOffset;

	while (lineStart < buffer.length) {
		const newlineIndex = buffer.indexOf(0x0a, lineStart);
		if (newlineIndex === -1) break; // trailing partial line, not consumed

		const line = buffer.toString("utf8", lineStart, newlineIndex);
		lineStart = newlineIndex + 1;
		consumedThrough = lineStart;

		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			continue;
		}

		if (!isAttachmentRecord(parsed)) continue;

		attachments.push({
			hookEvent: parsed.attachment.hookEvent,
			hookName: parsed.attachment.hookName,
			stdout: parsed.attachment.stdout,
			command: parsed.attachment.command,
			exitCode: parsed.attachment.exitCode,
			durationMs: parsed.attachment.durationMs,
			timestamp: parsed.timestamp,
		});
	}

	return { attachments, newOffset: consumedThrough };
}
