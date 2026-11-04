import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createEventBus } from "../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.ts";
import { UHarnessBridge } from "../src/core/u-harness/bridge.ts";
import { setSlmDebugRunId } from "../src/core/u-harness/debug-log.ts";
import uHarnessExtension from "../src/extensions/u-harness/index.ts";

type HandlerFn = (...args: unknown[]) => Promise<unknown>;

afterEach(() => {
	setSlmDebugRunId(undefined);
});

function createHandlerContext() {
	const notifications: Array<{ message: string; type?: string }> = [];
	return {
		notifications,
		ctx: {
			ui: {
				notify: (message: string, type?: string) => {
					notifications.push({ message, type });
				},
			},
		},
	};
}

describe("u-harness runtime integration", () => {
	it("compresses a task into an architectural brief", async () => {
		const bridge = new UHarnessBridge({ pipeline: "u-shaped" });
		bridge.callSlmDefault = async () =>
			"=== ARCHITECTURAL BRIEF ===\nTarget function: fib(n) in fib.py.\n=== END BRIEF ===";

		const brief = await bridge.compressInbound("Fix fibonacci", [{ path: "fib.py", content: "def fib(n): ..." }]);

		expect(brief).toContain("Target function: fib(n)");
	});

	it("resets run evidence on before_agent_start without any SLM round-trip", async () => {
		const directory = mkdtempSync(join(tmpdir(), "uh-run-reset-"));
		const logFile = join(directory, "uh-debug.log");
		const saved = { uh: process.env.UH_SLM_DEBUG, log: process.env.UH_SLM_DEBUG_LOG };
		process.env.UH_SLM_DEBUG = "1";
		process.env.UH_SLM_DEBUG_LOG = logFile;

		const runtime = createExtensionRuntime();
		const extension = await loadExtensionFromFactory(
			uHarnessExtension,
			process.cwd(),
			createEventBus(),
			runtime,
			"builtin:u-harness",
		);
		const beforeHandler = extension.handlers.get("before_agent_start")?.[0] as HandlerFn | undefined;
		runtime.getSettings = () =>
			({
				uHarness: { pipeline: "u-shaped", clm: { enabled: false } },
			}) as any;

		const stages: Array<string | undefined> = [];
		const originalCallSlmDefault = UHarnessBridge.prototype.callSlmDefault;
		UHarnessBridge.prototype.callSlmDefault = async () => {
			stages.push("ok");
			return "ok";
		};

		try {
			const { ctx } = createHandlerContext();
			await beforeHandler?.(
				{
					type: "before_agent_start",
					messageType: "user",
					prompt: "Add JWT verification to auth.ts",
					systemPrompt: "BASE PROMPT",
					systemPromptOptions: {},
				},
				ctx,
			);
			// Entity 2 moved into the per-request flow: run start does no SLM work.
			expect(stages).toEqual([]);

			const events = readFileSync(logFile, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as { event: string; stage?: string; runId?: number });
			const agentStart = events.find((entry) => entry.event === "agent-start");
			expect(agentStart?.stage).toBe("pipeline");
			expect(agentStart?.runId).toBe(1);

			await beforeHandler?.(
				{
					type: "before_agent_start",
					messageType: "user",
					prompt: "hello",
					systemPrompt: "BASE PROMPT",
					systemPromptOptions: {},
				},
				ctx,
			);
			const secondEvents = readFileSync(logFile, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as { runId?: number })
				.slice(events.length);
			expect(new Set(secondEvents.map((entry) => entry.runId))).toEqual(new Set([2]));
		} finally {
			UHarnessBridge.prototype.callSlmDefault = originalCallSlmDefault;
			if (saved.uh === undefined) delete process.env.UH_SLM_DEBUG;
			else process.env.UH_SLM_DEBUG = saved.uh;
			if (saved.log === undefined) delete process.env.UH_SLM_DEBUG_LOG;
			else process.env.UH_SLM_DEBUG_LOG = saved.log;
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("does nothing in baseline mode", async () => {
		const runtime = createExtensionRuntime();
		const extension = await loadExtensionFromFactory(
			uHarnessExtension,
			process.cwd(),
			createEventBus(),
			runtime,
			"builtin:u-harness",
		);
		const handler = extension.handlers.get("before_agent_start")?.[0] as HandlerFn | undefined;
		runtime.getSettings = () =>
			({
				uHarness: { pipeline: "baseline" },
			}) as any;

		const { ctx } = createHandlerContext();
		const result = await handler?.(
			{
				type: "before_agent_start",
				messageType: "user",
				prompt: "Add JWT verification",
				systemPrompt: "BASE PROMPT",
				systemPromptOptions: {},
			},
			ctx,
		);

		expect(result).toBeUndefined();
	});

	it("runs the fixed flow per internal request: compress, LLM, decompress", async () => {
		const directory = mkdtempSync(join(tmpdir(), "uh-three-stage-"));
		const logFile = join(directory, "uh-debug.log");
		const saved = { uh: process.env.UH_SLM_DEBUG, log: process.env.UH_SLM_DEBUG_LOG };
		process.env.UH_SLM_DEBUG = "1";
		process.env.UH_SLM_DEBUG_LOG = logFile;

		const runtime = createExtensionRuntime();
		const extension = await loadExtensionFromFactory(
			uHarnessExtension,
			process.cwd(),
			createEventBus(),
			runtime,
			"builtin:u-harness",
		);
		const handler = (name: string) => extension.handlers.get(name)?.[0] as HandlerFn | undefined;
		const beforeHandler = handler("before_agent_start");
		const contextHandler = handler("context");
		const contextWithSystemHandler = handler("context_with_system");
		const messageEndHandler = handler("message_end");
		runtime.getSettings = () =>
			({
				uHarness: { pipeline: "u-shaped", clm: { enabled: false } },
			}) as any;

		const stages: Array<string | undefined> = [];
		const originalCallSlmDefault = UHarnessBridge.prototype.callSlmDefault;
		UHarnessBridge.prototype.callSlmDefault = async (prompt: string, stage?: string) => {
			stages.push(stage);
			if (prompt.includes("TUGAS KOMPRESI REQUEST SLM")) {
				return "=== REQUEST PADAT ===\nPerbaiki auth: verifyJwt harus menolak token kedaluwarsa.\n=== END REQUEST PADAT ===";
			}
			if (prompt.includes("TUGAS DEKOMPRESI BALASAN SLM")) {
				return "### FILE: auth.ts\nexport function verifyJwt() { return false; }\n\nVERDICT: PASS";
			}
			return "ok";
		};

		try {
			const { ctx } = createHandlerContext();
			await beforeHandler?.(
				{
					type: "before_agent_start",
					messageType: "user",
					prompt: "Add JWT verification to auth.ts",
					systemPrompt: "BASE PROMPT",
					systemPromptOptions: {},
				},
				ctx,
			);
			const messages = [
				{ role: "system", content: "SYSTEM" },
				{ role: "user", content: [{ type: "text", text: `Add JWT verification: ${"konteks ".repeat(80)}` }] },
			];
			await contextHandler?.({ type: "context", messages }, ctx);
			const projected = (await contextWithSystemHandler?.({ type: "context_with_system", messages }, ctx)) as
				| { messages: Array<Record<string, unknown>> }
				| undefined;
			expect(projected).toBeDefined();
			expect(stages).toEqual(["SLM compress"]);
			const replacement = (await messageEndHandler?.(
				{
					type: "message_end",
					message: { role: "assistant", content: [{ type: "text", text: "ganti perbandingan token" }] },
				},
				ctx,
			)) as { message: { content: Array<Record<string, unknown>> } } | undefined;
			expect(replacement).toBeDefined();
			expect(stages).toEqual(["SLM compress", "SLM decompress"]);

			const events = readFileSync(logFile, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as { event: string; stage?: string; runId?: number });
			const stageSequence = events
				.map((entry) => entry.stage)
				.filter((stage, index, all) => stage !== all[index - 1]);
			expect(stageSequence).toEqual(["pipeline", "LLM", "SLM compress", "SLM decompress"]);
			expect(events.some((entry) => entry.event === "llm-call-start")).toBe(true);
			expect(events.some((entry) => entry.event === "request-compressed")).toBe(true);
			expect(events.some((entry) => entry.event === "request-expanded")).toBe(true);

			const runIds = new Set(events.filter((entry) => entry.event !== "debug-ui").map((entry) => entry.runId));
			expect(runIds).toEqual(new Set([1]));

			const compressed = projected!.messages[1].content as Array<{ text: string }>;
			expect(compressed[0].text).toContain("verifyJwt");
			const call = replacement!.message.content.find((part) => part.name === "write") as
				| { arguments: { path: string; content: string } }
				| undefined;
			expect(call?.arguments.path).toBe("auth.ts");

			await beforeHandler?.(
				{
					type: "before_agent_start",
					messageType: "user",
					prompt: "hello",
					systemPrompt: "BASE PROMPT",
					systemPromptOptions: {},
				},
				ctx,
			);
			const secondEvents = readFileSync(logFile, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as { runId?: number })
				.slice(events.length);
			expect(new Set(secondEvents.map((entry) => entry.runId))).toEqual(new Set([2]));
		} finally {
			UHarnessBridge.prototype.callSlmDefault = originalCallSlmDefault;
			if (saved.uh === undefined) delete process.env.UH_SLM_DEBUG;
			else process.env.UH_SLM_DEBUG = saved.uh;
			if (saved.log === undefined) delete process.env.UH_SLM_DEBUG_LOG;
			else process.env.UH_SLM_DEBUG_LOG = saved.log;
			rmSync(directory, { recursive: true, force: true });
		}
	});
});

function toolResultMessage(toolName: string, text: string): unknown {
	return {
		role: "toolResult",
		toolCallId: `call_${toolName}`,
		toolName,
		content: [{ type: "text", text }],
		isError: false,
		timestamp: Date.now(),
	};
}

function messageText(messages: Array<Record<string, unknown>>): number {
	let total = 0;
	for (const message of messages) {
		const content = message.content;
		if (typeof content === "string") total += content.length;
		else if (Array.isArray(content)) {
			for (const part of content as Array<{ type: string; text?: string }>) {
				if (part.type === "text") total += (part.text ?? "").length;
			}
		}
	}
	return total;
}

describe("u-harness per-request wrap", () => {
	async function loadHandlers() {
		const runtime = createExtensionRuntime();
		const extension = await loadExtensionFromFactory(
			uHarnessExtension,
			process.cwd(),
			createEventBus(),
			runtime,
			"builtin:u-harness",
		);
		const handler = (name: string) => extension.handlers.get(name)?.[0] as HandlerFn | undefined;
		return {
			runtime,
			before: handler("before_agent_start"),
			context: handler("context"),
			contextWithSystem: handler("context_with_system"),
			turnEnd: handler("turn_end"),
			end: handler("agent_end"),
		};
	}

	function useSettings(settings: Record<string, unknown>) {
		return settings;
	}

	it("logs per-request llm-call-start and llm-call-end evidence", async () => {
		const directory = mkdtempSync(join(tmpdir(), "uh-call-ev-"));
		const logFile = join(directory, "uh-debug.log");
		const saved = { uh: process.env.UH_SLM_DEBUG, log: process.env.UH_SLM_DEBUG_LOG };
		process.env.UH_SLM_DEBUG = "1";
		process.env.UH_SLM_DEBUG_LOG = logFile;
		const handlers = await loadHandlers();
		handlers.runtime.getSettings = () =>
			useSettings({ uHarness: { pipeline: "u-shaped", clm: { enabled: false } } }) as any;

		const originalCallSlmDefault = UHarnessBridge.prototype.callSlmDefault;
		UHarnessBridge.prototype.callSlmDefault = async (prompt: string) =>
			prompt.includes("TUGAS KOMPRESI SLM")
				? "=== ARCHITECTURAL BRIEF ===\nTarget: auth.ts\n=== END BRIEF ==="
				: "ok";

		try {
			const { ctx } = createHandlerContext();
			await handlers.before?.(
				{
					type: "before_agent_start",
					messageType: "user",
					prompt: "Fix auth",
					systemPrompt: "BASE",
					systemPromptOptions: {},
				},
				ctx,
			);
			const messages = [
				{ role: "user", content: [{ type: "text", text: "Fix auth" }] },
				{ role: "assistant", content: [{ type: "text", text: "Working on it" }] },
			];
			await handlers.context?.({ type: "context", messages }, ctx);
			await handlers.turnEnd?.(
				{
					type: "turn_end",
					turnIndex: 0,
					message: {
						role: "assistant",
						content: [{ type: "text", text: "Done" }],
						usage: { input: 1200, output: 45, cacheRead: 300, cacheWrite: 0, totalTokens: 1245 },
					},
					toolResults: [],
				},
				ctx,
			);

			const events = readFileSync(logFile, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as Record<string, unknown>);
			const callStart = events.find((entry) => entry.event === "llm-call-start");
			const callEnd = events.find((entry) => entry.event === "llm-call-end");
			expect(callStart?.stage).toBe("LLM");
			expect(callStart?.requestIndex).toBe(1);
			expect(callStart?.contextChars).toBe(messageText(messages as any));
			const usage = callEnd?.usage as { input?: number } | undefined;
			expect(callEnd?.stage).toBe("LLM");
			expect(callEnd?.requestIndex).toBe(1);
			expect(usage?.input).toBe(1200);
			expect(typeof callEnd?.ms).toBe("number");

			await handlers.before?.(
				{
					type: "before_agent_start",
					messageType: "user",
					prompt: "hello",
					systemPrompt: "BASE",
					systemPromptOptions: {},
				},
				ctx,
			);
			await handlers.context?.({ type: "context", messages }, ctx);
			const events2 = readFileSync(logFile, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as Record<string, unknown>);
			const starts = events2.filter((entry) => entry.event === "llm-call-start");
			expect(starts.at(-1)?.requestIndex).toBe(1);
			expect(starts.at(-1)?.runId).toBe(2);
		} finally {
			UHarnessBridge.prototype.callSlmDefault = originalCallSlmDefault;
			if (saved.uh === undefined) delete process.env.UH_SLM_DEBUG;
			else process.env.UH_SLM_DEBUG = saved.uh;
			if (saved.log === undefined) delete process.env.UH_SLM_DEBUG_LOG;
			else process.env.UH_SLM_DEBUG_LOG = saved.log;
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("reuses a cached compressed request instead of calling the SLM twice", async () => {
		const directory = mkdtempSync(join(tmpdir(), "uh-req-cache-"));
		const logFile = join(directory, "uh-debug.log");
		const saved = { uh: process.env.UH_SLM_DEBUG, log: process.env.UH_SLM_DEBUG_LOG };
		process.env.UH_SLM_DEBUG = "1";
		process.env.UH_SLM_DEBUG_LOG = logFile;
		const handlers = await loadHandlers();
		handlers.runtime.getSettings = () =>
			useSettings({
				uHarness: { pipeline: "u-shaped", clm: { enabled: false }, slm: { perRequestCompression: true } },
			}) as any;

		let compressCalls = 0;
		const originalCallSlmDefault = UHarnessBridge.prototype.callSlmDefault;
		UHarnessBridge.prototype.callSlmDefault = async (prompt: string) => {
			if (prompt.includes("TUGAS KOMPRESI REQUEST SLM")) {
				compressCalls += 1;
				return "=== REQUEST PADAT ===\nringkas\n=== END REQUEST PADAT ===";
			}
			return "ok";
		};

		try {
			const { ctx } = createHandlerContext();
			const messages = [
				{ role: "system", content: "SYSTEM PROMPT" },
				{ role: "user", content: [{ type: "text", text: `Fix auth: ${"konteks ".repeat(80)}` }] },
			];
			await handlers.context?.({ type: "context", messages }, ctx);
			const first = (await handlers.contextWithSystem?.({ type: "context_with_system", messages }, ctx)) as
				| { messages: Array<any> }
				| undefined;
			expect(first).toBeDefined();
			expect((first!.messages[0] as any).content).toBe("SYSTEM PROMPT");
			expect(compressCalls).toBe(1);

			await handlers.context?.({ type: "context", messages }, ctx);
			await handlers.contextWithSystem?.({ type: "context_with_system", messages }, ctx);
			expect(compressCalls).toBe(1);

			const events = readFileSync(logFile, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as Record<string, unknown>);
			expect(events.some((entry) => entry.event === "request-cache-hit")).toBe(true);
		} finally {
			UHarnessBridge.prototype.callSlmDefault = originalCallSlmDefault;
			if (saved.uh === undefined) delete process.env.UH_SLM_DEBUG;
			else process.env.UH_SLM_DEBUG = saved.uh;
			if (saved.log === undefined) delete process.env.UH_SLM_DEBUG_LOG;
			else process.env.UH_SLM_DEBUG_LOG = saved.log;
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("skips compression when perRequestCompression is disabled", async () => {
		const directory = mkdtempSync(join(tmpdir(), "uh-req-off-"));
		const logFile = join(directory, "uh-debug.log");
		const saved = { uh: process.env.UH_SLM_DEBUG, log: process.env.UH_SLM_DEBUG_LOG };
		process.env.UH_SLM_DEBUG = "1";
		process.env.UH_SLM_DEBUG_LOG = logFile;
		const handlers = await loadHandlers();
		handlers.runtime.getSettings = () =>
			useSettings({
				uHarness: { pipeline: "u-shaped", clm: { enabled: false }, slm: { perRequestCompression: false } },
			}) as any;

		const originalCallSlmDefault = UHarnessBridge.prototype.callSlmDefault;
		UHarnessBridge.prototype.callSlmDefault = async (prompt: string) =>
			prompt.includes("TUGAS KOMPRESI SLM")
				? "=== ARCHITECTURAL BRIEF ===\nTarget: auth.ts\n=== END BRIEF ==="
				: "RINGKASAN SINGKAT";

		try {
			const { ctx } = createHandlerContext();
			await handlers.before?.(
				{
					type: "before_agent_start",
					messageType: "user",
					prompt: "Fix auth",
					systemPrompt: "BASE",
					systemPromptOptions: {},
				},
				ctx,
			);
			const messages = [
				{ role: "user", content: [{ type: "text", text: "Fix auth" }] },
				toolResultMessage("read", "X".repeat(600)),
				toolResultMessage("bash", "Y".repeat(400)),
				toolResultMessage("edit", "Z".repeat(300)),
			];
			const result = await handlers.contextWithSystem?.({ type: "context_with_system", messages }, ctx);
			expect(result).toBeUndefined();
			const events = readFileSync(logFile, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as Record<string, unknown>);
			expect(events.some((entry) => entry.event === "history-compressed")).toBe(false);
		} finally {
			UHarnessBridge.prototype.callSlmDefault = originalCallSlmDefault;
			if (saved.uh === undefined) delete process.env.UH_SLM_DEBUG;
			else process.env.UH_SLM_DEBUG = saved.uh;
			if (saved.log === undefined) delete process.env.UH_SLM_DEBUG_LOG;
			else process.env.UH_SLM_DEBUG_LOG = saved.log;
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("skips the SLM flow when the request is below the size threshold", async () => {
		const directory = mkdtempSync(join(tmpdir(), "uh-req-small-"));
		const logFile = join(directory, "uh-debug.log");
		const saved = { uh: process.env.UH_SLM_DEBUG, log: process.env.UH_SLM_DEBUG_LOG };
		process.env.UH_SLM_DEBUG = "1";
		process.env.UH_SLM_DEBUG_LOG = logFile;
		const handlers = await loadHandlers();
		handlers.runtime.getSettings = () =>
			useSettings({ uHarness: { pipeline: "u-shaped", clm: { enabled: false } } }) as any;

		const originalCallSlmDefault = UHarnessBridge.prototype.callSlmDefault;
		let slmCalls = 0;
		UHarnessBridge.prototype.callSlmDefault = async () => {
			slmCalls += 1;
			return "=== REQUEST PADAT ===\nringkas\n=== END REQUEST PADAT ===";
		};

		try {
			const { ctx } = createHandlerContext();
			const messages = [{ role: "user", content: [{ type: "text", text: "hi" }] }];
			await handlers.context?.({ type: "context", messages }, ctx);
			const result = await handlers.contextWithSystem?.({ type: "context_with_system", messages }, ctx);
			expect(result).toBeUndefined();
			expect(slmCalls).toBe(0);
			const events = readFileSync(logFile, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as Record<string, unknown>);
			const skip = events.find((entry) => entry.event === "request-skip");
			expect(String(skip?.reason)).toContain("ambang");
		} finally {
			UHarnessBridge.prototype.callSlmDefault = originalCallSlmDefault;
			if (saved.uh === undefined) delete process.env.UH_SLM_DEBUG;
			else process.env.UH_SLM_DEBUG = saved.uh;
			if (saved.log === undefined) delete process.env.UH_SLM_DEBUG_LOG;
			else process.env.UH_SLM_DEBUG_LOG = saved.log;
			rmSync(directory, { recursive: true, force: true });
		}
	});
});

describe("per-request flow inside one agent", () => {
	async function loadFlowHandlers() {
		const runtime = createExtensionRuntime();
		const extension = await loadExtensionFromFactory(
			uHarnessExtension,
			process.cwd(),
			createEventBus(),
			runtime,
			"builtin:u-harness",
		);
		const handler = (name: string) => extension.handlers.get(name)?.[0] as HandlerFn | undefined;
		return {
			runtime,
			before: handler("before_agent_start"),
			context: handler("context"),
			contextWithSystem: handler("context_with_system"),
			messageEnd: handler("message_end"),
			turnEnd: handler("turn_end"),
			end: handler("agent_end"),
		};
	}

	it("compresses the actual request each turn and expands the answer before execution", async () => {
		const directory = mkdtempSync(join(tmpdir(), "uh-flow-"));
		const logFile = join(directory, "uh-debug.log");
		const memoryPath = join(directory, "working_memory.md");
		const saved = { uh: process.env.UH_SLM_DEBUG, log: process.env.UH_SLM_DEBUG_LOG };
		process.env.UH_SLM_DEBUG = "1";
		process.env.UH_SLM_DEBUG_LOG = logFile;
		const handlers = await loadFlowHandlers();
		handlers.runtime.getSettings = () =>
			({
				uHarness: { pipeline: "u-shaped", clm: { enabled: true, workingMemoryPath: memoryPath } },
			}) as any;

		const prompts: string[] = [];
		const originalCallSlmDefault = UHarnessBridge.prototype.callSlmDefault;
		UHarnessBridge.prototype.callSlmDefault = async (prompt: string) => {
			prompts.push(prompt);
			if (prompt.includes("TUGAS KOMPRESI REQUEST SLM")) {
				return "=== REQUEST PADAT ===\nPerbaiki verifyJwt di src/auth.ts agar token kedaluwarsa ditolak.\n=== END REQUEST PADAT ===";
			}
			if (prompt.includes("TUGAS DEKOMPRESI BALASAN SLM")) {
				return "### FILE: src/auth.ts\nexport function verifyJwt() { return false; }\n\nVERDICT: PASS";
			}
			return "ok";
		};

		try {
			const { ctx } = createHandlerContext();
			await handlers.before?.(
				{
					type: "before_agent_start",
					messageType: "user",
					prompt: "Perbaiki verifikasi token",
					systemPrompt: "BASE",
					systemPromptOptions: {},
				},
				ctx,
			);

			const messages = [
				{ role: "system", content: "SYSTEM" },
				{ role: "user", content: [{ type: "text", text: "Perbaiki verifikasi token" }] },
				toolResultMessage("read", `const x = 1; // src/auth.ts verifyJwt\n${"detail kode ".repeat(60)}`),
			];
			await handlers.context?.({ type: "context", messages }, ctx);
			const projected = (await handlers.contextWithSystem?.({ type: "context_with_system", messages }, ctx)) as
				| { messages: Array<Record<string, unknown>> }
				| undefined;
			expect(projected).toBeDefined();
			const compressed = JSON.stringify(projected!.messages);
			expect(compressed).toContain("verifyJwt");

			const replacement = (await handlers.messageEnd?.(
				{
					type: "message_end",
					message: { role: "assistant", content: [{ type: "text", text: "ganti perbandingan token" }] },
				},
				ctx,
			)) as { message: { content: Array<Record<string, unknown>> } } | undefined;
			expect(replacement).toBeDefined();
			const parts = replacement!.message.content;
			const writeCall = parts.find((part) => part.name === "write") as
				| { arguments: { path: string; content: string } }
				| undefined;
			expect(writeCall?.arguments.path).toBe("src/auth.ts");
			expect(writeCall?.arguments.content).toContain("verifyJwt");
			expect(JSON.stringify(parts)).not.toContain("VERDICT");

			const events = readFileSync(logFile, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as Record<string, unknown>);
			const compressedEvent = events.find((entry) => entry.event === "request-compressed");
			expect(compressedEvent?.requestIndex).toBe(1);
			expect(Number(compressedEvent?.charsAfter)).toBeLessThan(Number(compressedEvent?.charsBefore));
			const expanded = events.find((entry) => entry.event === "request-expanded");
			expect(expanded?.requestIndex).toBe(1);
			expect(expanded?.patches).toBe(1);
			expect(events.some((entry) => entry.event === "request-bypass")).toBe(false);
			const memory = readFileSync(memoryPath, "utf8");
			expect(memory).toContain("CURRENT TASK");
			expect(memory).toContain("verifyJwt");
		} finally {
			UHarnessBridge.prototype.callSlmDefault = originalCallSlmDefault;
			if (saved.uh === undefined) delete process.env.UH_SLM_DEBUG;
			else process.env.UH_SLM_DEBUG = saved.uh;
			if (saved.log === undefined) delete process.env.UH_SLM_DEBUG_LOG;
			else process.env.UH_SLM_DEBUG_LOG = saved.log;
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("keeps the LLM tool calls when the SLM expansion yields no patch (bypass path)", async () => {
		const directory = mkdtempSync(join(tmpdir(), "uh-flow-bypass-"));
		const logFile = join(directory, "uh-debug.log");
		const saved = { uh: process.env.UH_SLM_DEBUG, log: process.env.UH_SLM_DEBUG_LOG };
		process.env.UH_SLM_DEBUG = "1";
		process.env.UH_SLM_DEBUG_LOG = logFile;
		const handlers = await loadFlowHandlers();
		handlers.runtime.getSettings = () => ({ uHarness: { pipeline: "u-shaped", clm: { enabled: false } } }) as any;

		const originalCallSlmDefault = UHarnessBridge.prototype.callSlmDefault;
		UHarnessBridge.prototype.callSlmDefault = async (prompt: string) => {
			if (prompt.includes("TUGAS KOMPRESI REQUEST SLM"))
				return "=== REQUEST PADAT ===\nringkas\n=== END REQUEST PADAT ===";
			if (prompt.includes("TUGAS DEKOMPRESI BALASAN SLM"))
				return "Jawaban lengkap tanpa berkas.\n\nVERDICT: UNKNOWN";
			return "ok";
		};

		try {
			const { ctx } = createHandlerContext();
			await handlers.before?.(
				{
					type: "before_agent_start",
					messageType: "user",
					prompt: "Baca berkas lalu jelaskan",
					systemPrompt: "BASE",
					systemPromptOptions: {},
				},
				ctx,
			);
			await handlers.context?.({ type: "context", messages: [] }, ctx);
			await handlers.contextWithSystem?.(
				{
					type: "context_with_system",
					messages: [
						{ role: "user", content: [{ type: "text", text: `Baca berkas besar: ${"konteks ".repeat(80)}` }] },
					],
				},
				ctx,
			);
			const original = {
				role: "assistant",
				content: [{ type: "toolCall", id: "c1", name: "read", arguments: { path: "a.ts" } }],
			};
			const replacement = (await handlers.messageEnd?.({ type: "message_end", message: original }, ctx)) as
				| { message: { content: Array<Record<string, unknown>> } }
				| undefined;
			expect(replacement).toBeUndefined();

			const events = readFileSync(logFile, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as Record<string, unknown>);
			const bypass = events.find((entry) => entry.event === "request-bypass");
			expect(bypass?.reason).toBeDefined();
		} finally {
			UHarnessBridge.prototype.callSlmDefault = originalCallSlmDefault;
			if (saved.uh === undefined) delete process.env.UH_SLM_DEBUG;
			else process.env.UH_SLM_DEBUG = saved.uh;
			if (saved.log === undefined) delete process.env.UH_SLM_DEBUG_LOG;
			else process.env.UH_SLM_DEBUG_LOG = saved.log;
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("shows a live footer status and finishes each request with a summary", async () => {
		const handlers = await loadFlowHandlers();
		handlers.runtime.getSettings = () => ({ uHarness: { pipeline: "u-shaped", clm: { enabled: false } } }) as any;
		const statuses: Array<{ key: string; text: string | undefined }> = [];
		const notifications: Array<{ message: string; type?: string }> = [];
		const ctx = {
			ui: {
				notify: (message: string, type?: string) => notifications.push({ message, type }),
				setStatus: (key: string, text: string | undefined) => statuses.push({ key, text }),
			},
		};

		const originalCallSlmDefault = UHarnessBridge.prototype.callSlmDefault;
		UHarnessBridge.prototype.callSlmDefault = async (prompt: string) =>
			prompt.includes("TUGAS KOMPRESI REQUEST SLM")
				? "=== REQUEST PADAT ===\nringkas\n=== END REQUEST PADAT ==="
				: "Jawaban lengkap.\nVERDICT: PASS";

		try {
			await handlers.before?.(
				{
					type: "before_agent_start",
					messageType: "user",
					prompt: "Perbaiki bug",
					systemPrompt: "BASE",
					systemPromptOptions: {},
				},
				ctx,
			);
			await handlers.context?.({ type: "context", messages: [] }, ctx);
			await handlers.contextWithSystem?.(
				{
					type: "context_with_system",
					messages: [
						{ role: "user", content: [{ type: "text", text: `Perbaiki bug berikut: ${"konteks ".repeat(80)}` }] },
					],
				},
				ctx,
			);
			await handlers.turnEnd?.(
				{
					type: "turn_end",
					turnIndex: 0,
					message: { role: "assistant", content: [], usage: { input: 100 } },
					toolResults: [],
				},
				ctx,
			);

			const key = statuses.find((entry) => entry.key === "u-harness");
			expect(key).toBeDefined();
			const texts = statuses
				.map((entry) => entry.text)
				.filter(Boolean)
				.join(" | ");
			expect(texts).toContain("SLM compress");
			expect(texts).toContain("LLM");
			expect(notifications.some((entry) => entry.message.includes("1 request"))).toBe(true);
		} finally {
			UHarnessBridge.prototype.callSlmDefault = originalCallSlmDefault;
		}
	});
});
