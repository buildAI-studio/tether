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

interface OffsetEntry {
	transcriptPath: string;
	byteOffset: number;
}

/** On-disk shape of the offset sidecar: one entry per session_id, so two
 * sessions that happen to share a log directory (e.g. both fell back to the
 * same `cwd`) never reset each other's offset. */
type OffsetMap = Record<string, OffsetEntry>;

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
 * Reads <logDir>/<COMPOSITION_OFFSET_FILENAME> and returns the whole map,
 * or {} if the file doesn't exist or fails to parse as an object. Matches
 * manifest.ts's convention of catching readFileSync errors and falling
 * back to a safe default rather than throwing.
 */
function readOffsetMap(logDir: string): OffsetMap {
	try {
		const content = readFileSync(join(logDir, COMPOSITION_OFFSET_FILENAME), "utf-8");
		const parsed = JSON.parse(content);
		if (parsed === null || typeof parsed !== "object") return {};
		return parsed as OffsetMap;
	} catch {
		return {};
	}
}

/**
 * Returns the byte offset recorded for `sessionId`. Returns 0 if the
 * sidecar file doesn't exist, fails to parse, has no entry for this
 * session, or that entry's transcriptPath doesn't match the one passed in
 * -- a changed transcript path means start over, don't miscount into the
 * wrong file.
 */
export function readOffset(logDir: string, sessionId: string, transcriptPath: string): number {
	const entry = readOffsetMap(logDir)[sessionId];
	if (entry === undefined || entry.transcriptPath !== transcriptPath) return 0;
	return entry.byteOffset;
}

/**
 * Sets this session's entry to { transcriptPath, byteOffset } and writes
 * the whole map back to <logDir>/<COMPOSITION_OFFSET_FILENAME>, creating
 * logDir first if needed. Preserves every other session's entry already in
 * the map -- a missing/corrupt file is treated as an empty map, never as
 * license to clobber other sessions' entries.
 */
export function writeOffset(logDir: string, sessionId: string, transcriptPath: string, byteOffset: number): void {
	mkdirSync(logDir, { recursive: true });
	const map = readOffsetMap(logDir);
	map[sessionId] = { transcriptPath, byteOffset };
	writeFileSync(join(logDir, COMPOSITION_OFFSET_FILENAME), JSON.stringify(map));
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
