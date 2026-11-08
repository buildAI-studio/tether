#!/usr/bin/env node
/**
 * Trail MCP server — lets coding agents (Claude Code, Cursor, Windsurf, …)
 * stream their work into Trail as traces.
 *
 * The agent authenticates with a Trail API key pair (env vars) and calls
 * these tools; each call becomes a span with Trail's gen_ai.* semantics, so
 * runs appear in Observations → Tracing (full tree), errors in Exceptions,
 * and agent/tool rollups in Analytics → Agents — no UI changes required.
 *
 * Tools:
 *   trail_start_run      begin a run (returns run_id)
 *   trail_log_step       record a task or tool step
 *   trail_log_llm_call   record an LLM call with messages/completion + usage
 *   trail_log_exception  record a failure (shows in Exceptions)
 *   trail_finish_run     close the run (emits the root agent span)
 *
 * Server construction (state, tool registration, the pure span-building
 * functions) lives in tools.ts, kept separate so it can be imported by
 * tests without this file's stdio transport connection running.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { TrailConfig } from "./otlp.js";
import { JudgeConfig } from "./judge.js";
import { buildTrailServer } from "./tools.js";

if (process.argv[2] === "hook") {
	// This hook's stdout can be read by Claude Code as live control data
	// (PreToolUse's JSON-shaped stdout alters its own permission flow;
	// SessionStart's stdout is injected as context), so this path must
	// always exit 0, even if the dynamic import itself fails (e.g. a
	// corrupted/partial install missing dist/hooks/cli.js) or main()
	// rejects for a reason not already caught inside it.
	try {
		const { main } = await import("./hooks/cli.js");
		await main(process.argv.slice(3));
	} catch {
		// never let this subcommand exit non-zero or crash with output.
	}
	process.exit(0);
}

const DEFAULT_LOCAL_URL = "http://127.0.0.1:4319";

const cfg: TrailConfig = {
	url: process.env.TRAIL_URL ?? DEFAULT_LOCAL_URL,
	publicKey: process.env.TRAIL_PUBLIC_KEY,
	secretKey: process.env.TRAIL_SECRET_KEY,
	environment: process.env.TRAIL_ENV ?? "default",
	serviceName: process.env.TRAIL_APP ?? "coding-agent",
};

const judgeCfg: JudgeConfig | undefined =
	process.env.TRAIL_JUDGE_PROVIDER && process.env.TRAIL_JUDGE_API_KEY
		? {
				provider: process.env.TRAIL_JUDGE_PROVIDER,
				apiKey: process.env.TRAIL_JUDGE_API_KEY,
				model: process.env.TRAIL_JUDGE_MODEL,
				baseUrl: process.env.TRAIL_JUDGE_BASE_URL,
			}
		: undefined;

const server = buildTrailServer(cfg, judgeCfg);
const transport = new StdioServerTransport();
await server.connect(transport);
console.error("trail-mcp ready (stdio)");
