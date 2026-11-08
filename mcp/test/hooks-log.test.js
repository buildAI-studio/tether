import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  resolveLogDir, readOffset, writeOffset, appendEntries,
  COMPOSITION_LOG_FILENAME, COMPOSITION_OFFSET_FILENAME,
} from "../dist/hooks/log.js";

describe("resolveLogDir", () => {
  test("prefers scratchpad_dir when present", () => {
    assert.equal(resolveLogDir({ scratchpad_dir: "/s", cwd: "/c" }), "/s");
  });
  test("falls back to cwd when scratchpad_dir is absent", () => {
    assert.equal(resolveLogDir({ cwd: "/c" }), "/c");
  });
  test("falls back to process.cwd() when neither is present", () => {
    assert.equal(resolveLogDir({}), process.cwd());
  });
});

describe("offset persistence", () => {
  test("readOffset returns 0 when no offset file exists yet", () => {
    const dir = mkdtempSync(join(tmpdir(), "trail-log-"));
    assert.equal(readOffset(dir, "s1", "/t.jsonl"), 0);
  });

  test("writeOffset then readOffset round-trips for the same session and transcript path", () => {
    const dir = mkdtempSync(join(tmpdir(), "trail-log-"));
    writeOffset(dir, "s1", "/t.jsonl", 123);
    assert.equal(readOffset(dir, "s1", "/t.jsonl"), 123);
  });

  test("readOffset resets to 0 if the transcript path has changed for that session", () => {
    const dir = mkdtempSync(join(tmpdir(), "trail-log-"));
    writeOffset(dir, "s1", "/t-old.jsonl", 999);
    assert.equal(readOffset(dir, "s1", "/t-new.jsonl"), 0);
  });

  test("readOffset returns 0 for a session that has no entry yet, even if other sessions do", () => {
    const dir = mkdtempSync(join(tmpdir(), "trail-log-"));
    writeOffset(dir, "s1", "/t.jsonl", 500);
    assert.equal(readOffset(dir, "s2", "/t.jsonl"), 0);
  });

  test("two different sessionIds sharing the same transcriptPath don't reset each other's offset", () => {
    const dir = mkdtempSync(join(tmpdir(), "trail-log-"));
    writeOffset(dir, "s1", "/shared.jsonl", 100);
    writeOffset(dir, "s2", "/shared.jsonl", 50);
    assert.equal(readOffset(dir, "s1", "/shared.jsonl"), 100);
    assert.equal(readOffset(dir, "s2", "/shared.jsonl"), 50);

    // Advancing one session's offset further must not disturb the other's.
    writeOffset(dir, "s1", "/shared.jsonl", 200);
    assert.equal(readOffset(dir, "s1", "/shared.jsonl"), 200);
    assert.equal(readOffset(dir, "s2", "/shared.jsonl"), 50);
  });

  test("the sidecar file on disk is a map keyed by sessionId", () => {
    const dir = mkdtempSync(join(tmpdir(), "trail-log-"));
    writeOffset(dir, "s1", "/t.jsonl", 10);
    writeOffset(dir, "s2", "/t.jsonl", 20);
    const onDisk = JSON.parse(readFileSync(join(dir, COMPOSITION_OFFSET_FILENAME), "utf8"));
    assert.deepEqual(onDisk, {
      s1: { transcriptPath: "/t.jsonl", byteOffset: 10 },
      s2: { transcriptPath: "/t.jsonl", byteOffset: 20 },
    });
  });
});

describe("appendEntries", () => {
  test("appends one JSON line per entry, creating the directory if needed", () => {
    const dir = join(mkdtempSync(join(tmpdir(), "trail-log-")), "nested");
    const entry = { source: "pre_tool_use_hook", kind: "tool_file", nameOrPath: "/a.ts",
      sizeBytes: 4, timestamp: "t", sessionId: "s1" };
    appendEntries(dir, [entry]);
    appendEntries(dir, [entry]);
    const lines = readFileSync(join(dir, COMPOSITION_LOG_FILENAME), "utf8").trim().split("\n");
    assert.equal(lines.length, 2);
    assert.deepEqual(JSON.parse(lines[0]), entry);
  });

  test("writing zero entries creates no file", () => {
    const dir = mkdtempSync(join(tmpdir(), "trail-log-"));
    appendEntries(dir, []);
    assert.equal(existsSync(join(dir, COMPOSITION_LOG_FILENAME)), false);
  });
});
