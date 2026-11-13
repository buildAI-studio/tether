#!/usr/bin/env node
// Copies the non-TypeScript vendored assets under src/static/vendor/ into dist/static/vendor/ --
// tsc only compiles .ts files, so these would otherwise be silently missing from the published
// package (server.ts's ELK_JS readFileSync, and the /vendor/elk.bundled.js route, both read from
// dist at runtime). Same rationale and shape as copy-registry-snapshot.mjs.
import { mkdirSync, copyFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, "..", "src", "static", "vendor");
const destDir = join(here, "..", "dist", "static", "vendor");

mkdirSync(destDir, { recursive: true });
for (const name of readdirSync(srcDir)) {
	copyFileSync(join(srcDir, name), join(destDir, name));
	console.log(`Copied ${join(srcDir, name)} -> ${join(destDir, name)}`);
}
