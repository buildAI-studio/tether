/**
 * File-system layer for the composition-capture hook: resolving where to
 * write a local log, persisting an append-only JSONL log of AttachmentEntry
 * records, and persisting a byte-offset sidecar so repeated hook firings
 * against the same transcript don't reprocess old data. No orchestration
 * here -- a later task wires this together with transcript.ts/capture.ts.
 */

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { AttachmentEntry } from "./capture.js";

export const COMPOSITION_LOG_FILENAME = "trail-composition.jsonl";
export const COMPOSITION_OFFSET_FILENAME = "trail-composition.offset.json";

interface OffsetFile {
	transcriptPath: string;
	byteOffset: number;
}

/**
 * Prefers payload.scratchpad_dir, falls back to payload.cwd, then to
 * process.cwd() -- in that order, skipping any value that isn't a
 * non-empty string.
 */
export function resolveLogDir(payload: { scratchpad_dir?: unknown; cwd?: unknown }): string {
	if (typeof payload.scratchpad_dir === "string" && payload.scratchpad_dir.length > 0) {
		return payload.scratchpad_dir;
	}
	if (typeof payload.cwd === "string" && payload.cwd.length > 0) {
		return payload.cwd;
	}
	return process.cwd();
}

/**
 * Reads <logDir>/<COMPOSITION_OFFSET_FILENAME>. Returns 0 if the file
 * doesn't exist, fails to parse, or its transcriptPath doesn't match the
 * one passed in -- a changed transcript path means start over, don't
 * miscount into the wrong file. Matches manifest.ts's convention of
 * catching readFileSync errors and falling back to a safe default rather
 * than throwing.
 */
export function readOffset(logDir: string, transcriptPath: string): number {
	try {
		const content = readFileSync(join(logDir, COMPOSITION_OFFSET_FILENAME), "utf-8");
		const parsed = JSON.parse(content) as OffsetFile;
		if (parsed.transcriptPath !== transcriptPath) return 0;
		return parsed.byteOffset;
	} catch {
		return 0;
	}
}

/**
 * Writes { transcriptPath, byteOffset } as JSON to
 * <logDir>/<COMPOSITION_OFFSET_FILENAME>, creating logDir first if needed.
 */
export function writeOffset(logDir: string, transcriptPath: string, byteOffset: number): void {
	mkdirSync(logDir, { recursive: true });
	const offsetFile: OffsetFile = { transcriptPath, byteOffset };
	writeFileSync(join(logDir, COMPOSITION_OFFSET_FILENAME), JSON.stringify(offsetFile));
}

/**
 * Appends each entry as one JSON line to
 * <logDir>/<COMPOSITION_LOG_FILENAME>, creating the directory if needed.
 * Uses appendFileSync so concurrent hook invocations each add their own
 * lines rather than clobbering the file. Writing zero entries is a no-op
 * -- it never creates the directory or file.
 */
export function appendEntries(logDir: string, entries: AttachmentEntry[]): void {
	if (entries.length === 0) return;
	mkdirSync(logDir, { recursive: true });
	const lines = entries.map((entry) => JSON.stringify(entry) + "\n").join("");
	appendFileSync(join(logDir, COMPOSITION_LOG_FILENAME), lines);
}
