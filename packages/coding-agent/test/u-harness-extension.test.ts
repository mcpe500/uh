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

	it("appends the SLM brief to the system prompt in u-shaped mode", async () => {
		const runtime = createExtensionRuntime();
		const extension = await loadExtensionFromFactory(
			uHarnessExtension,
			process.cwd(),
			createEventBus(),
			runtime,
			"builtin:u-harness",
		);
		const handler = extension.handlers.get("before_agent_start")?.[0] as HandlerFn | undefined;
		expect(handler).toBeDefined();
		runtime.getSettings = () =>
			({
				uHarness: { pipeline: "u-shaped" },
			}) as any;

		const originalCallSlmDefault = UHarnessBridge.prototype.callSlmDefault;
		UHarnessBridge.prototype.callSlmDefault = async () =>
			"=== ARCHITECTURAL BRIEF ===\nTarget function: auth() in auth.ts.\n=== END BRIEF ===";
		try {
			const { ctx } = createHandlerContext();
			const result = (await handler?.(
				{
					type: "before_agent_start",
					messageType: "user",
					prompt: "Add JWT verification",
					systemPrompt: "BASE PROMPT",
					systemPromptOptions: {},
				},
				ctx,
			)) as { systemPrompt?: string } | undefined;

			expect(result?.systemPrompt).toContain("BASE PROMPT");
			expect(result?.systemPrompt).toContain("=== U-HARNESS ARCHITECTURAL BRIEF ===");
			expect(result?.systemPrompt).toContain("Target function: auth()");
		} finally {
			UHarnessBridge.prototype.callSlmDefault = originalCallSlmDefault;
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

	it("runs the three separate stages per turn: SLM compress, LLM, SLM decompress", async () => {
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
		const beforeHandler = extension.handlers.get("before_agent_start")?.[0] as HandlerFn | undefined;
		const endHandler = extension.handlers.get("agent_end")?.[0] as HandlerFn | undefined;
		runtime.getSettings = () =>
			({
				uHarness: { pipeline: "u-shaped", clm: { enabled: false } },
			}) as any;

		const stages: Array<string | undefined> = [];
		const originalCallSlmDefault = UHarnessBridge.prototype.callSlmDefault;
		UHarnessBridge.prototype.callSlmDefault = async (prompt: string, stage?: string) => {
			stages.push(stage);
			if (prompt.includes("TUGAS KOMPRESI SLM")) {
				return "=== ARCHITECTURAL BRIEF ===\nTarget function: auth() in auth.ts.\n=== END BRIEF ===";
			}
			return "### FILE: auth.ts\nexport function auth() { return true; }";
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
			await endHandler?.(
				{
					type: "agent_end",
					messages: [
						{ role: "assistant", content: [{ type: "text", text: "Added JWT verification to auth()." }] },
					],
				},
				ctx,
			);

			expect(stages).toEqual(["SLM compress", "SLM decompress"]);
			const events = readFileSync(logFile, "utf8")
				.trim()
				.split("\n")
				.map(
					(line) =>
						JSON.parse(line) as {
							event: string;
							stage?: string;
							runId?: number;
							prompt?: string;
							output?: string;
							ms?: number;
						},
				);
			const stageSequence = events
				.map((entry) => entry.stage)
				.filter((stage, index, all) => stage !== all[index - 1]);
			expect(stageSequence).toEqual(["pipeline", "SLM compress", "LLM", "SLM decompress"]);
			expect(events.some((entry) => entry.event === "llm-start")).toBe(true);
			expect(events.some((entry) => entry.event === "llm-end")).toBe(true);
			expect(events.some((entry) => entry.event === "decompress-ok")).toBe(true);

			const llmStart = events.find((entry) => entry.event === "llm-start");
			const llmEnd = events.find((entry) => entry.event === "llm-end");
			expect(llmStart?.prompt).toContain("Add JWT verification to auth.ts");
			expect(llmStart?.prompt).toContain("Target function: auth() in auth.ts.");
			expect(llmEnd?.output).toContain("Added JWT verification to auth().");
			expect(typeof llmEnd?.ms).toBe("number");

			const runIds = new Set(events.filter((entry) => entry.event !== "debug-ui").map((entry) => entry.runId));
			expect(runIds).toEqual(new Set([1]));

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
				.map((line) => JSON.parse(line) as { event: string; stage?: string; runId?: number; prompt?: string })
				.slice(events.length);
			expect(secondEvents.length).toBeGreaterThan(0);
			expect(new Set(secondEvents.map((entry) => entry.runId))).toEqual(new Set([2]));
			const secondLlmStart = secondEvents.find((entry) => entry.event === "llm-start");
			expect(secondLlmStart?.prompt).toBe("SPESIFIKASI TUGAS:\nhello");
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

	it("compresses old tool results per request and caches them", async () => {
		const directory = mkdtempSync(join(tmpdir(), "uh-req-compress-"));
		const logFile = join(directory, "uh-debug.log");
		const saved = { uh: process.env.UH_SLM_DEBUG, log: process.env.UH_SLM_DEBUG_LOG };
		process.env.UH_SLM_DEBUG = "1";
		process.env.UH_SLM_DEBUG_LOG = logFile;
		const handlers = await loadHandlers();
		handlers.runtime.getSettings = () =>
			useSettings({
				uHarness: { pipeline: "u-shaped", clm: { enabled: false }, slm: { perRequestCompression: true } },
			}) as any;

		let ringkasCalls = 0;
		const originalCallSlmDefault = UHarnessBridge.prototype.callSlmDefault;
		UHarnessBridge.prototype.callSlmDefault = async (prompt: string) => {
			if (prompt.includes("TUGAS KOMPRESI SLM")) {
				return "=== ARCHITECTURAL BRIEF ===\nTarget: auth.ts\n=== END BRIEF ===";
			}
			if (prompt.includes("TUGAS RINGKAS HISTORY SLM")) {
				ringkasCalls += 1;
				return "RINGKASAN SINGKAT";
			}
			return "ok";
		};

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
			await handlers.context?.({ type: "context", messages: [] }, ctx);

			const messages = [
				{ role: "system", content: "SYSTEM PROMPT" },
				{ role: "user", content: [{ type: "text", text: "Fix auth" }] },
				toolResultMessage("read", "X".repeat(600)),
				{ role: "assistant", content: [{ type: "text", text: "step" }] },
				toolResultMessage("bash", "Y".repeat(400)),
				{ role: "assistant", content: [{ type: "text", text: "latest" }] },
				toolResultMessage("edit", "Z".repeat(50)),
			];
			const result = (await handlers.contextWithSystem?.({ type: "context_with_system", messages }, ctx)) as
				| { messages: Array<any> }
				| undefined;
			expect(result).toBeDefined();
			const out = result!.messages;
			expect((out[0] as any).content).toBe("SYSTEM PROMPT");
			const compressed = (out[2].content as Array<{ text: string }>)[0].text;
			expect(compressed).toContain("[DIRINGKAS SLM");
			expect(compressed).toContain("RINGKASAN SINGKAT");
			expect((out[4].content as Array<{ text: string }>)[0].text).toBe("Y".repeat(400));
			expect((out[6].content as Array<{ text: string }>)[0].text).toBe("Z".repeat(50));

			const events = readFileSync(logFile, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as Record<string, unknown>);
			const compressedEvents = events.filter((entry) => entry.event === "history-compressed");
			expect(compressedEvents).toHaveLength(1);
			expect(compressedEvents[0]?.charsBefore).toBe(600);
			expect(compressedEvents[0]?.charsAfter).toBeLessThan(600);
			expect(compressedEvents[0]?.cached).toBe(false);

			// Same request again: cache hit, no extra SLM call.
			const before = ringkasCalls;
			const result2 = (await handlers.contextWithSystem?.({ type: "context_with_system", messages }, ctx)) as
				| { messages: Array<any> }
				| undefined;
			expect(ringkasCalls).toBe(before);
			const compressed2 = (result2!.messages[2].content as Array<{ text: string }>)[0].text;
			expect(compressed2).toBe(compressed);
			const compressedEvents2 = readFileSync(logFile, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as Record<string, unknown>)
				.filter((entry) => entry.event === "history-compressed");
			expect(compressedEvents2.at(-1)?.cached).toBe(true);

			// Nothing compressible (only 1 tool result = within the keep-recent window): log the skip reason.
			const small = [
				{ role: "user", content: [{ type: "text", text: "Fix auth" }] },
				toolResultMessage("read", "X".repeat(600)),
			];
			const result3 = await handlers.contextWithSystem?.({ type: "context_with_system", messages: small }, ctx);
			expect(result3).toBeUndefined();
			const events3 = readFileSync(logFile, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as Record<string, unknown>);
			const skip = events3.filter((entry) => entry.event === "history-skip");
			expect(skip.length).toBeGreaterThan(0);
			expect(String(skip.at(-1)?.reason)).toContain("tool result");
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

	it("decompresses each assistant step with a verdict and stores it in the CLM", async () => {
		const directory = mkdtempSync(join(tmpdir(), "uh-req-decomp-"));
		const logFile = join(directory, "uh-debug.log");
		const memoryPath = join(directory, "working_memory.md");
		const saved = { uh: process.env.UH_SLM_DEBUG, log: process.env.UH_SLM_DEBUG_LOG };
		process.env.UH_SLM_DEBUG = "1";
		process.env.UH_SLM_DEBUG_LOG = logFile;
		const handlers = await loadHandlers();
		handlers.runtime.getSettings = () =>
			useSettings({
				uHarness: {
					pipeline: "u-shaped",
					clm: { enabled: true, workingMemoryPath: memoryPath },
					slm: { perRequestDecompression: true },
				},
			}) as any;

		const originalCallSlmDefault = UHarnessBridge.prototype.callSlmDefault;
		UHarnessBridge.prototype.callSlmDefault = async (prompt: string) => {
			if (prompt.includes("TUGAS KOMPRESI SLM")) {
				return "=== ARCHITECTURAL BRIEF ===\nTarget: auth.ts\nPassing criteria:\n- fib(6) == 8\n=== END BRIEF ===";
			}
			if (prompt.includes("TUGAS DEKOMPRESI & VERIFIKASI SLM")) {
				return `Rekonstruksi lengkap langkah: mengubah base case fib.\n\nVERDICT: PASS`;
			}
			return "ok";
		};

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
			await handlers.context?.(
				{ type: "context", messages: [{ role: "user", content: [{ type: "text", text: "Fix auth" }] }] },
				ctx,
			);
			await handlers.turnEnd?.(
				{
					type: "turn_end",
					turnIndex: 0,
					message: {
						role: "assistant",
						content: [{ type: "text", text: "Mengubah base case fib menjadi n<=0 -> 0." }],
					},
					toolResults: [],
				},
				ctx,
			);

			const events = readFileSync(logFile, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as Record<string, unknown>);
			const decompressOk = events.filter((entry) => entry.event === "decompress-ok");
			expect(decompressOk).toHaveLength(1);
			expect(decompressOk[0]?.requestIndex).toBe(1);
			expect(decompressOk[0]?.verdict).toBe("PASS");
			const memory = readFileSync(memoryPath, "utf8");
			expect(memory).toContain("DECOMPRESSED OUTPUT");
			expect(memory).toContain("VERDICT: PASS");
			expect(memory).toContain("Request 1");

			// Pure tool-call step (no text): decompress skipped WITH a reason, call evidence still logged.
			await handlers.context?.({ type: "context", messages: [] }, ctx);
			await handlers.turnEnd?.(
				{
					type: "turn_end",
					turnIndex: 1,
					message: { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "read", arguments: {} }] },
					toolResults: [],
				},
				ctx,
			);
			const events2 = readFileSync(logFile, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as Record<string, unknown>);
			expect(events2.filter((entry) => entry.event === "decompress-ok")).toHaveLength(1);
			const ends = events2.filter((entry) => entry.event === "llm-call-end");
			expect(ends.at(-1)?.requestIndex).toBe(2);
			const skip = events2.find((entry) => entry.event === "decompress-skip");
			expect(skip?.requestIndex).toBe(2);
			expect(String(skip?.reason)).toContain("teks");
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

describe("per-request wrap", () => {
	it("skips decompression when the turn produced no assistant message", async () => {
		const runtime = createExtensionRuntime();
		const extension = await loadExtensionFromFactory(
			uHarnessExtension,
			process.cwd(),
			createEventBus(),
			runtime,
			"builtin:u-harness",
		);
		const beforeHandler = extension.handlers.get("before_agent_start")?.[0] as HandlerFn | undefined;
		const endHandler = extension.handlers.get("agent_end")?.[0] as HandlerFn | undefined;
		runtime.getSettings = () =>
			({
				uHarness: { pipeline: "u-shaped", clm: { enabled: false } },
			}) as any;

		const stages: Array<string | undefined> = [];
		const originalCallSlmDefault = UHarnessBridge.prototype.callSlmDefault;
		UHarnessBridge.prototype.callSlmDefault = async (prompt: string, stage?: string) => {
			stages.push(stage);
			return prompt.includes("TUGAS KOMPRESI SLM")
				? "=== ARCHITECTURAL BRIEF ===\nTarget: auth.ts\n=== END BRIEF ==="
				: "### FILE: auth.ts\nexport function auth() {}";
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
			await endHandler?.({ type: "agent_end", messages: [] }, ctx);

			expect(stages).toEqual(["SLM compress"]);
		} finally {
			UHarnessBridge.prototype.callSlmDefault = originalCallSlmDefault;
		}
	});
});
