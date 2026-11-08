/**
 * Embedded SQLite storage for Tether's ingested OTLP spans.
 *
 * Schema is deliberately minimal: indexed key columns for what's queried
 * today (traceId, spanId, parentSpanId, name, timestamps), plus a `raw`
 * JSON blob holding the full span object. Avoids modeling every gen_ai.*
 * attribute as a SQL column before the UI work that will query them exists.
 */

import Database from "better-sqlite3";
import envPaths from "env-paths";
import { mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";

export interface StoredSpan {
	traceId: string;
	spanId: string;
	parentSpanId: string | null;
	name: string;
	startTimeUnixNano: string;
	endTimeUnixNano: string;
	raw: string;
}

/** OS-appropriate data directory for Tether's SQLite file (XDG on Linux, Application Support on macOS, %APPDATA% on Windows). */
export function resolveDataDir(): string {
	return envPaths("trailai-tether", { suffix: "" }).data;
}

/** Opens (creating if needed) the spans database at the given path. Safe to call repeatedly on the same path.
 * `:memory:` is better-sqlite3's special in-process path (used by tests) -- it has no filesystem
 * entry, so the directory-create/permission-lockdown steps below (which only make sense for a real
 * file) are skipped for it. */
export function openDatabase(dbPath: string): Database.Database {
	if (dbPath !== ":memory:") {
		mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
	}
	const db = new Database(dbPath);
	if (dbPath !== ":memory:") {
		chmodSync(dbPath, 0o600);
	}
	db.exec(`
		CREATE TABLE IF NOT EXISTS spans (
			traceId TEXT NOT NULL,
			spanId TEXT NOT NULL,
			parentSpanId TEXT,
			name TEXT NOT NULL,
			startTimeUnixNano TEXT NOT NULL,
			endTimeUnixNano TEXT NOT NULL,
			raw TEXT NOT NULL,
			PRIMARY KEY (traceId, spanId)
		);
		CREATE INDEX IF NOT EXISTS idx_spans_traceId ON spans(traceId);
	`);
	return db;
}

/** Inserts a span, replacing any existing row with the same traceId+spanId. */
export function insertSpan(db: Database.Database, span: StoredSpan): void {
	db.prepare(
		`INSERT OR REPLACE INTO spans (traceId, spanId, parentSpanId, name, startTimeUnixNano, endTimeUnixNano, raw)
		 VALUES (@traceId, @spanId, @parentSpanId, @name, @startTimeUnixNano, @endTimeUnixNano, @raw)`,
	).run(span);
}

/** Number of distinct traces (runs) stored, not total span count. */
export function countTraces(db: Database.Database): number {
	const row = db.prepare(`SELECT COUNT(DISTINCT traceId) as count FROM spans`).get() as { count: number };
	return row.count;
}
