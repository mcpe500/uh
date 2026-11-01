/**
 * Opt-in debug logging for the U-Harness SLM pipeline.
 *
 * Set `UH_SLM_DEBUG=1` to append one JSON line per SLM request/response to
 * `UH_SLM_DEBUG_LOG` (default `~/.pi/agent/uh-slm-debug.log`). Logging never
 * throws and never stores the resolved API key.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { getAgentDir } from "../../config.ts";

/** True when UH_SLM_DEBUG is set to a non-empty value other than "0"/"false". */
export function isSlmDebugEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const value = env.UH_SLM_DEBUG;
	return value !== undefined && value !== "" && value !== "0" && value !== "false";
}

/** Debug log path: UH_SLM_DEBUG_LOG or the agent directory default. */
export function slmDebugLogPath(env: NodeJS.ProcessEnv = process.env): string {
	return env.UH_SLM_DEBUG_LOG ?? `${getAgentDir()}/uh-slm-debug.log`;
}

/** Run id attached to every entry while set; the extension bumps it once per turn. */
let currentRunId: number | undefined;

/** Set the run id stamped onto subsequent debug entries (undefined clears it). */
export function setSlmDebugRunId(runId: number | undefined): void {
	currentRunId = runId;
}

/** Append one entry as a JSON line; failures are swallowed so logging cannot break the pipeline. */
export function appendSlmDebug(entry: Record<string, unknown>, env: NodeJS.ProcessEnv = process.env): void {
	if (!isSlmDebugEnabled(env)) return;
	try {
		const logPath = slmDebugLogPath(env);
		mkdirSync(dirname(logPath), { recursive: true });
		const safeEntry = "apiKey" in entry ? { ...entry, apiKey: "[redacted]" } : entry;
		const runId = currentRunId !== undefined ? { runId: currentRunId } : {};
		appendFileSync(logPath, `${JSON.stringify({ ts: new Date().toISOString(), ...runId, ...safeEntry })}\n`);
	} catch {
		// Debug logging must never break the pipeline.
	}
}
