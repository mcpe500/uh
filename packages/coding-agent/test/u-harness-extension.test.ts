import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createEventBus } from "../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.ts";
import { UHarnessBridge } from "../src/core/u-harness/bridge.ts";
import uHarnessExtension from "../src/extensions/u-harness/index.ts";

type HandlerFn = (...args: unknown[]) => Promise<unknown>;

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
				.map((line) => JSON.parse(line) as { event: string; stage?: string });
			const stageSequence = events
				.map((entry) => entry.stage)
				.filter((stage, index, all) => stage !== all[index - 1]);
			expect(stageSequence).toEqual(["pipeline", "SLM compress", "LLM", "SLM decompress"]);
			expect(events.some((entry) => entry.event === "llm-start")).toBe(true);
			expect(events.some((entry) => entry.event === "llm-end")).toBe(true);
			expect(events.some((entry) => entry.event === "decompress-ok")).toBe(true);
		} finally {
			UHarnessBridge.prototype.callSlmDefault = originalCallSlmDefault;
			if (saved.uh === undefined) delete process.env.UH_SLM_DEBUG;
			else process.env.UH_SLM_DEBUG = saved.uh;
			if (saved.log === undefined) delete process.env.UH_SLM_DEBUG_LOG;
			else process.env.UH_SLM_DEBUG_LOG = saved.log;
			rmSync(directory, { recursive: true, force: true });
		}
	});

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
