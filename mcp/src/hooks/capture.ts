/**
 * Turns raw Claude Code hook payloads (PreToolUse, UserPromptSubmit
 * expansions) and Task 1's transcript-scanned attachment records into the
 * normalized AttachmentEntry shape this feature reports on. Pure functions
 * only -- no I/O, no log persistence; later tasks own that.
 */

import { sanitize } from "../sanitize.js";
import type { TranscriptAttachment } from "./transcript.js";

export interface AttachmentEntry {
	source: "pre_tool_use_hook" | "user_prompt_expansion_hook" | "transcript_hook_attachment" | "self_reported";
	kind: "skill" | "memory_file" | "claude_md" | "tool_file" | "mcp_server" | "hook_injected_context";
	nameOrPath: string;
	sizeBytes: number;
	contentPreview?: string;
	timestamp: string;
}

const FILE_TOOL_NAMES = new Set(["Read", "Write", "Edit"]);

/**
 * The Skill tool's input field name isn't confirmed (see the spec's open
 * "empirical confirmation" item), so this tries the plausible names in
 * order before giving up and stringifying the whole input.
 */
function skillNameFrom(toolInput: Record<string, unknown>): string {
	if (typeof toolInput.name === "string") return toolInput.name;
	if (typeof toolInput.skill === "string") return toolInput.skill;
	return JSON.stringify(toolInput);
}

function mcpServerNameFrom(toolName: string, payload: Record<string, unknown>): string {
	const mcpServer = payload.mcp_server;
	if (mcpServer !== null && typeof mcpServer === "object") {
		const name = (mcpServer as Record<string, unknown>).name;
		if (typeof name === "string") return name;
	}
	// tool_name is "mcp__<server>__<tool>"; the server name is between the first and second "__".
	const parts = toolName.split("__");
	return parts[1] ?? toolName;
}

export function fromPreToolUse(payload: Record<string, unknown>): AttachmentEntry[] {
	const toolName = payload.tool_name;
	if (typeof toolName !== "string") return [];
	const toolInput = (payload.tool_input !== null && typeof payload.tool_input === "object"
		? payload.tool_input
		: {}) as Record<string, unknown>;
	const timestamp = new Date().toISOString();

	if (FILE_TOOL_NAMES.has(toolName)) {
		const filePath = toolInput.file_path;
		if (typeof filePath !== "string") return [];
		return [{
			source: "pre_tool_use_hook",
			kind: "tool_file",
			nameOrPath: filePath,
			sizeBytes: Buffer.byteLength(filePath, "utf8"),
			timestamp,
		}];
	}

	if (toolName === "Skill") {
		return [{
			source: "pre_tool_use_hook",
			kind: "skill",
			nameOrPath: skillNameFrom(toolInput),
			sizeBytes: 0,
			timestamp,
		}];
	}

	if (/^mcp__/.test(toolName)) {
		return [{
			source: "pre_tool_use_hook",
			kind: "mcp_server",
			nameOrPath: mcpServerNameFrom(toolName, payload),
			sizeBytes: 0,
			timestamp,
		}];
	}

	return [];
}

export function fromUserPromptExpansion(payload: Record<string, unknown>): AttachmentEntry[] {
	const commandName = payload.command_name;
	if (typeof commandName !== "string") return [];
	const kind = payload.expansion_type === "slash_command" ? "skill" : "mcp_server";

	const entry: AttachmentEntry = {
		source: "user_prompt_expansion_hook",
		kind,
		nameOrPath: commandName,
		sizeBytes: 0,
		timestamp: new Date().toISOString(),
	};

	if (payload.command_args !== undefined) {
		const commandArgs = typeof payload.command_args === "string"
			? payload.command_args
			: String(payload.command_args);
		entry.sizeBytes = Buffer.byteLength(commandArgs, "utf8");
		entry.contentPreview = sanitize(commandArgs) as string;
	}

	return [entry];
}

/**
 * Pulls the actual injected-context text out of a hook's raw stdout. Claude
 * Code hooks report additional context under hookSpecificOutput.additionalContext;
 * additional_context/additionalContext at the top level are defensive fallbacks for
 * other hook shapes. If none of those parse out as a string, the raw stdout itself
 * is the best available text.
 */
function extractInjectedContext(stdout: string): string {
	try {
		const parsed = JSON.parse(stdout);
		if (parsed !== null && typeof parsed === "object") {
			const obj = parsed as Record<string, unknown>;
			const hookSpecificOutput = obj.hookSpecificOutput;
			if (hookSpecificOutput !== null && typeof hookSpecificOutput === "object") {
				const additionalContext = (hookSpecificOutput as Record<string, unknown>).additionalContext;
				if (typeof additionalContext === "string") return additionalContext;
			}
			if (typeof obj.additional_context === "string") return obj.additional_context;
			if (typeof obj.additionalContext === "string") return obj.additionalContext;
		}
	} catch {
		// not JSON -- fall through to the raw string
	}
	return stdout;
}

export function fromTranscriptAttachment(att: TranscriptAttachment): AttachmentEntry {
	const extracted = extractInjectedContext(att.stdout);
	return {
		source: "transcript_hook_attachment",
		kind: "hook_injected_context",
		nameOrPath: att.hookName,
		sizeBytes: Buffer.byteLength(extracted, "utf8"),
		contentPreview: sanitize(extracted) as string,
		timestamp: att.timestamp,
	};
}
