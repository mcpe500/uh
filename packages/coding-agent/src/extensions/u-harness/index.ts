/**
 * Runtime integration for the U-Harness inbound compression stage.
 *
 * When the pipeline is `u-shaped`, this extension asks the configured SLM for an architectural
 * brief before the main agent runs and appends that brief to the system prompt. Conversational
 * prompts (greetings, one-word replies) skip the SLM round-trip; every stage decision is
 * recorded in the U-Harness debug log when `UH_SLM_DEBUG=1`.
 *
 * When the SLM provider is `janas`, the SLM is an external Janas server managed by this
 * extension and stopped again on session shutdown.
 */
import type { ExtensionAPI } from "../../core/extensions/types.ts";
import type { UHarnessSettings } from "../../core/settings-schema.ts";
import { UHarnessBridge } from "../../core/u-harness/bridge.ts";
import { appendSlmDebug, isSlmDebugEnabled, slmDebugLogPath } from "../../core/u-harness/debug-log.ts";
import { type DebugUiServer, getRunningDebugUiUrl, startDebugUiServer } from "../../core/u-harness/debug-server.ts";
import { JanasServer } from "../../core/u-harness/janas.ts";

/** Pure greetings and one-word replies gain nothing from compression; skip the SLM round-trip for them. */
function isConversationalPrompt(prompt: string): boolean {
	const trimmed = prompt.trim();
	if (trimmed.length > 32 || trimmed.includes("\n")) return false;
	return /^\s*(hai|hi|halo|hello|hey|pagi|siang|sore|malam|terima ?kasih|makasih|thanks|thx|oke?|ok|yes|no|ya|tidak|test)[\s!.,?]*$/iu.test(
		trimmed,
	);
}

export default function uHarnessExtension(pi: ExtensionAPI): void {
	let janasServer: JanasServer | undefined;
	let debugUi: DebugUiServer | undefined;
	let debugUiAnnounced = false;

	// With UH_SLM_DEBUG=1, serve the debug log at http://127.0.0.1:<port> (UH_DEBUG_UI_PORT, default 4949).
	if (isSlmDebugEnabled()) {
		const preferredPort = Number(process.env.UH_DEBUG_UI_PORT ?? 4949);
		startDebugUiServer(slmDebugLogPath(), Number.isFinite(preferredPort) ? preferredPort : undefined)
			.then((ui) => {
				debugUi = ui;
				appendSlmDebug({ event: "debug-ui", url: ui.url });
			})
			.catch(() => {
				// The UI is a convenience; pipeline logging keeps working without it.
			});
	}

	const resolveSettings = async (settings: UHarnessSettings | undefined): Promise<UHarnessSettings | undefined> => {
		if ((settings?.slm?.provider ?? "openai") !== "janas") return settings;
		janasServer ??= new JanasServer(settings ?? {});
		const baseUrl = await janasServer.start();
		return { ...settings, slm: { ...settings?.slm, baseUrl } };
	};

	pi.on("session_shutdown", async () => {
		await janasServer?.stop();
		janasServer = undefined;
		await debugUi?.close();
		debugUi = undefined;
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const settings = pi.getSettings().uHarness;
		if ((settings?.pipeline ?? "u-shaped") !== "u-shaped") return;
		if (event.messageType !== "user" || !event.prompt.trim()) return;

		appendSlmDebug({
			event: "agent-start",
			pipelineMode: settings?.pipeline ?? "u-shaped",
			promptChars: event.prompt.length,
			promptPreview: event.prompt.slice(0, 200),
		});
		const debugUrl = debugUi?.url ?? getRunningDebugUiUrl();
		if (debugUrl && !debugUiAnnounced) {
			debugUiAnnounced = true;
			ctx.ui.notify(`U-Harness debug UI: ${debugUrl}`);
		}
		if (isConversationalPrompt(event.prompt)) {
			appendSlmDebug({ event: "brief-skipped", reason: "conversational prompt without a coding task" });
			return;
		}

		try {
			const resolvedSettings = await resolveSettings(settings);
			const bridge = new UHarnessBridge(resolvedSettings ?? {});
			const brief = await bridge.compressInbound(event.prompt, []);
			if (!brief.trim()) {
				appendSlmDebug({ event: "brief-skipped", reason: "SLM returned an empty brief" });
				return;
			}
			appendSlmDebug({ event: "brief-injected", briefChars: brief.length, briefPreview: brief.slice(0, 400) });
			return {
				systemPrompt: `${event.systemPrompt}\n\n=== U-HARNESS ARCHITECTURAL BRIEF ===\n${brief}\n=== END U-HARNESS BRIEF ===`,
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			appendSlmDebug({ event: "agent-error", error: message });
			ctx.ui.notify(message, "warning");
		}
	});
}
