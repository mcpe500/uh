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
import {
	appendSlmDebug,
	isSlmDebugEnabled,
	setSlmDebugRunId,
	slmDebugLogPath,
} from "../../core/u-harness/debug-log.ts";
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
	let pendingTurn: { task: string; brief: string } | undefined;
	let runCounter = 0;
	let llmStartedAt: number | undefined;

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

		runCounter += 1;
		setSlmDebugRunId(runCounter);
		llmStartedAt = Date.now();
		appendSlmDebug({
			event: "agent-start",
			stage: "pipeline",
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
			appendSlmDebug({
				event: "brief-skipped",
				stage: "SLM compress",
				reason: "conversational prompt without a coding task",
			});
			appendSlmDebug({ event: "llm-start", stage: "LLM", prompt: `SPESIFIKASI TUGAS:\n${event.prompt}` });
			return;
		}

		try {
			const resolvedSettings = await resolveSettings(settings);
			const bridge = new UHarnessBridge(resolvedSettings ?? {});
			const brief = await bridge.compressInbound(event.prompt, []);
			if (!brief.trim()) {
				appendSlmDebug({ event: "brief-skipped", stage: "SLM compress", reason: "SLM returned an empty brief" });
				appendSlmDebug({ event: "llm-start", stage: "LLM", prompt: `SPESIFIKASI TUGAS:\n${event.prompt}` });
				return;
			}
			appendSlmDebug({
				event: "brief-injected",
				stage: "SLM compress",
				briefChars: brief.length,
				briefPreview: brief.slice(0, 400),
			});
			pendingTurn = { task: event.prompt, brief };
			appendSlmDebug({
				event: "llm-start",
				stage: "LLM",
				prompt: `SPESIFIKASI TUGAS:\n${event.prompt}\n\nARCHITECTURAL BRIEF (DARI SLM COMPRESS):\n${brief}`,
			});
			return {
				systemPrompt: `${event.systemPrompt}\n\n=== U-HARNESS ARCHITECTURAL BRIEF ===\n${brief}\n=== END U-HARNESS BRIEF ===`,
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			appendSlmDebug({ event: "agent-error", stage: "pipeline", error: message });
			ctx.ui.notify(message, "warning");
		}
	});

	// Stage 3: after the main LLM finishes, run SLM decompression on its output.
	pi.on("agent_end", async (event, ctx) => {
		let assistantOutput = "";
		for (let index = event.messages.length - 1; index >= 0; index--) {
			const message = event.messages[index];
			if (message.role !== "assistant") continue;
			const content = message.content;
			assistantOutput =
				typeof content === "string"
					? content
					: (content ?? [])
							.map((part) => (part.type === "text" ? part.text : ""))
							.join("")
							.trim();
			if (assistantOutput) break;
		}
		appendSlmDebug({
			event: "llm-end",
			stage: "LLM",
			messages: event.messages.length,
			ms: llmStartedAt !== undefined ? Date.now() - llmStartedAt : undefined,
			output: assistantOutput,
		});
		llmStartedAt = undefined;
		const pending = pendingTurn;
		pendingTurn = undefined;
		if (!pending) return;

		if (!assistantOutput) {
			appendSlmDebug({
				event: "brief-skipped",
				stage: "SLM decompress",
				reason: "turn produced no assistant output",
			});
			return;
		}

		try {
			const settings = pi.getSettings().uHarness;
			const resolvedSettings = await resolveSettings(settings);
			const bridge = new UHarnessBridge(resolvedSettings ?? {});
			const { output, patches } = await bridge.decompressOutbound({
				brief: pending.brief,
				assistantOutput,
			});
			if (bridge.settings.clm?.enabled !== false) {
				const memory = bridge.clm.loadMemory(pending.task);
				bridge.clm.saveMemory(bridge.clm.updateSection(memory, "DECOMPRESSED OUTPUT", output));
				appendSlmDebug({
					event: "clm-update",
					stage: "SLM decompress",
					section: "DECOMPRESSED OUTPUT",
					path: bridge.clm.workingMemoryPath,
				});
			}
			appendSlmDebug({
				event: "decompress-stored",
				stage: "SLM decompress",
				patches: patches.length,
				outputPreview: output.slice(0, 400),
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			appendSlmDebug({ event: "agent-error", stage: "SLM decompress", error: message });
			ctx.ui.notify(message, "warning");
		}
	});
}
