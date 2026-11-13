import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const VENDOR_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "static", "vendor");
const CHECKSUMS_PATH = join(VENDOR_DIR, "CHECKSUMS.txt");

function sha256(path) {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function parseChecksums(text) {
	return text
		.trim()
		.split("\n")
		.map((line) => {
			const [digest, name] = line.split(/\s{2,}/);
			return { digest, name };
		});
}

describe("vendor integrity", () => {
	test("every checksummed file's SHA-256 matches the committed digest", () => {
		const entries = parseChecksums(readFileSync(CHECKSUMS_PATH, "utf-8"));
		assert.ok(entries.length > 0);
		for (const { digest, name } of entries) {
			assert.equal(sha256(join(VENDOR_DIR, name)), digest, `${name} does not match its committed checksum`);
		}
	});

	test("every file in the vendor directory (except CHECKSUMS.txt) has a checksum entry", () => {
		const entries = parseChecksums(readFileSync(CHECKSUMS_PATH, "utf-8"));
		const named = new Set(entries.map((e) => e.name));
		const actual = readdirSync(VENDOR_DIR).filter((f) => f !== "CHECKSUMS.txt");
		for (const file of actual) {
			assert.ok(named.has(file), `${file} is in the vendor directory but has no CHECKSUMS.txt entry`);
		}
	});
});
