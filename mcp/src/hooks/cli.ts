/**
 * Entry point for the `trailai-mcp hook <event>` subcommand. Reads stdin
 * (Claude Code passes the hook payload as JSON on stdin) and hands it to
 * runHook. Does not call process.exit itself -- the caller in index.ts
 * does, so this stays testable without killing the test process, and so a
 * caller that wants to inspect stdout/exit behavior end-to-end can do so via
 * the compiled CLI entry instead.
 *
 * runHook already guarantees it never throws, but reading stdin here is
 * outside that guarantee -- a stream-level error on process.stdin (not
 * impossible for a hook's piped stdin) would otherwise propagate as an
 * uncaught rejection past index.ts's `process.exit(0)`, breaking this
 * subcommand's never-throw/always-exit-0 contract. The try/catch below
 * closes that gap the same way runHook closes its own.
 */

import { runHook } from "./run.js";

export async function main(argv: string[]): Promise<void> {
	try {
		let stdinText = "";
		for await (const chunk of process.stdin) {
			stdinText += chunk;
		}
		await runHook(argv[0], stdinText);
	} catch {
		// never throw -- see module comment.
	}
}
