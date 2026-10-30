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
});
