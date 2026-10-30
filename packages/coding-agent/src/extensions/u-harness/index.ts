/**
 * Runtime integration for the U-Harness inbound compression stage.
 *
 * When the pipeline is `u-shaped`, this extension asks the configured SLM for an architectural
 * brief before the main agent runs and appends that brief to the system prompt.
 */
import type { ExtensionAPI } from "../../core/extensions/types.ts";
import { UHarnessBridge } from "../../core/u-harness/bridge.ts";

export default function uHarnessExtension(pi: ExtensionAPI): void {
	pi.on("before_agent_start", async (event, ctx) => {
		const settings = pi.getSettings().uHarness;
		if ((settings?.pipeline ?? "u-shaped") !== "u-shaped") return;
		if (event.messageType !== "user" || !event.prompt.trim()) return;

		try {
			const bridge = new UHarnessBridge(settings ?? {});
			const brief = await bridge.compressInbound(event.prompt, []);
			if (!brief.trim()) return;
			return {
				systemPrompt: `${event.systemPrompt}\n\n=== U-HARNESS ARCHITECTURAL BRIEF ===\n${brief}\n=== END U-HARNESS BRIEF ===`,
			};
		} catch (error) {
			ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
		}
	});
}
