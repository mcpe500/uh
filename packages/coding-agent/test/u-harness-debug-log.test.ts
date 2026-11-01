import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	appendSlmDebug,
	isSlmDebugEnabled,
	setSlmDebugRunId,
	slmDebugLogPath,
} from "../src/core/u-harness/debug-log.ts";

const directories: string[] = [];

function tempEnv(logFile: string, debug?: string): NodeJS.ProcessEnv {
	return { UH_SLM_DEBUG: debug, UH_SLM_DEBUG_LOG: logFile, PATH: process.env.PATH };
}

afterEach(() => {
	setSlmDebugRunId(undefined);
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("u-harness SLM debug log", () => {
	it("detects enabled state from UH_SLM_DEBUG", () => {
		expect(isSlmDebugEnabled({ UH_SLM_DEBUG: "1" })).toBe(true);
		expect(isSlmDebugEnabled({ UH_SLM_DEBUG: "true" })).toBe(true);
		expect(isSlmDebugEnabled({ UH_SLM_DEBUG: "0" })).toBe(false);
		expect(isSlmDebugEnabled({ UH_SLM_DEBUG: "" })).toBe(false);
		expect(isSlmDebugEnabled({})).toBe(false);
	});

	it("appends masked JSON lines when enabled", () => {
		const directory = mkdtempSync(join(tmpdir(), "uh-debug-"));
		directories.push(directory);
		const logFile = join(directory, "uh-slm-debug.log");
		const env = tempEnv(logFile, "1");

		appendSlmDebug({ event: "request", baseUrl: "http://localhost:20128/v1", apiKey: "sk-secret" }, env);
		appendSlmDebug({ event: "response", ms: 12 }, env);

		const lines = readFileSync(logFile, "utf8").trim().split("\n");
		expect(lines).toHaveLength(2);
		const first = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
		expect(first.event).toBe("request");
		expect(first.baseUrl).toBe("http://localhost:20128/v1");
		expect(first.apiKey).toBe("[redacted]");
		expect(typeof first.ts).toBe("string");
	});

	it("writes nothing when debug is disabled", () => {
		const directory = mkdtempSync(join(tmpdir(), "uh-debug-"));
		directories.push(directory);
		const logFile = join(directory, "uh-slm-debug.log");

		appendSlmDebug({ event: "request" }, tempEnv(logFile, undefined));

		expect(() => readFileSync(logFile, "utf8")).toThrow();
		expect(slmDebugLogPath(tempEnv(logFile, "1"))).toBe(logFile);
	});

	it("attaches the current run id to every entry while one is set", () => {
		const directory = mkdtempSync(join(tmpdir(), "uh-run-"));
		directories.push(directory);
		const logFile = join(directory, "uh-slm-debug.log");
		const env = tempEnv(logFile, "1");

		setSlmDebugRunId(3);
		appendSlmDebug({ event: "request" }, env);
		setSlmDebugRunId(undefined);
		appendSlmDebug({ event: "response" }, env);

		const lines = readFileSync(logFile, "utf8").trim().split("\n");
		expect(JSON.parse(lines[0] ?? "{}").runId).toBe(3);
		expect("runId" in JSON.parse(lines[1] ?? "{}")).toBe(false);
	});
});
