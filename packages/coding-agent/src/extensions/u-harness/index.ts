/**
 * Runtime integration for the U-Harness inbound compression stage.
 *
 * When the pipeline is `u-shaped`, this extension asks the configured SLM for an architectural
 * brief before the main agent runs and appends that brief to the system prompt.
 *
 * When the SLM provider is `janas`, the SLM is an external Janas server managed by this
 * extension and stopped again on session shutdown.
 */
import type { ExtensionAPI } from "../../core/extensions/types.ts";
import type { UHarnessSettings } from "../../core/settings-schema.ts";
import { UHarnessBridge } from "../../core/u-harness/bridge.ts";
import { JanasServer } from "../../core/u-harness/janas.ts";

export default function uHarnessExtension(pi: ExtensionAPI): void {
	let janasServer: JanasServer | undefined;

	const resolveSettings = async (settings: UHarnessSettings | undefined): Promise<UHarnessSettings | undefined> => {
		if ((settings?.slm?.provider ?? "openai") !== "janas") return settings;
		janasServer ??= new JanasServer(settings ?? {});
		const baseUrl = await janasServer.start();
		return { ...settings, slm: { ...settings?.slm, baseUrl } };
	};

	pi.on("session_shutdown", async () => {
		await janasServer?.stop();
		janasServer = undefined;
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const settings = pi.getSettings().uHarness;
		if ((settings?.pipeline ?? "u-shaped") !== "u-shaped") return;
		if (event.messageType !== "user" || !event.prompt.trim()) return;

		try {
			const resolvedSettings = await resolveSettings(settings);
			const bridge = new UHarnessBridge(resolvedSettings ?? {});
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
