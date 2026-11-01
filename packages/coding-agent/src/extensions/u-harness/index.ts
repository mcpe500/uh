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
import { buildHistoryCompressPrompt } from "../../core/u-harness/compressor.ts";
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

/** Tool results below this size are cheaper to send verbatim than to spend an SLM call on. */
const HISTORY_COMPRESS_MIN_CHARS = 200;
/** Never compress the newest N tool results - the LLM needs the latest execution output verbatim. */
const HISTORY_KEEP_RECENT_TOOL_RESULTS = 2;
/** Upper bound on cached summaries (FIFO) so a long session cannot grow the map forever. */
const HISTORY_CACHE_MAX_ENTRIES = 200;

/** Plain text of one message's content parts (empty for pure tool-call steps). */
function messageText(message: { content?: unknown }): string {
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return (content as Array<{ type: string; text?: string }>)
		.map((part) => (part.type === "text" ? (part.text ?? "") : ""))
		.join("")
		.trim();
}

/** Concatenated text length across a message list, approximating request size. */
function messagesTextLength(messages: Array<Record<string, unknown>>): number {
	let total = 0;
	for (const message of messages) total += messageText(message as { content?: unknown }).length;
	return total;
}

/** Stable cache key for a tool result; must survive the runner's structuredClone. */
function historyCacheKey(message: { toolName?: unknown; content?: unknown }): string {
	return `${String(message.toolName ?? "")}\u0000${messageText(message as { content?: unknown })}`;
}

/** FIFO-bounded put for the history summary cache. */
function cachePut(cache: Map<string, string>, key: string, value: string): void {
	if (cache.size >= HISTORY_CACHE_MAX_ENTRIES) {
		const oldest = cache.keys().next().value;
		if (oldest !== undefined) cache.delete(oldest);
	}
	cache.set(key, value);
}

export default function uHarnessExtension(pi: ExtensionAPI): void {
	let janasServer: JanasServer | undefined;
	let debugUi: DebugUiServer | undefined;
	let debugUiAnnounced = false;
	let pendingTurn: { task: string; brief: string } | undefined;
	let runCounter = 0;
	let llmStartedAt: number | undefined;
	let requestCounter = 0;
	let currentRequestIndex: number | undefined;
	let llmCallStartedAt: number | undefined;
	const historyCache = new Map<string, string>();
	let decompressAccumulator: string[] = [];

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
		requestCounter = 0;
		currentRequestIndex = undefined;
		llmCallStartedAt = undefined;
		decompressAccumulator = [];
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

	// Per-request evidence: every LLM HTTP call inside the loop gets a start marker here.
	pi.on("context", async (event) => {
		const settings = pi.getSettings().uHarness;
		if ((settings?.pipeline ?? "u-shaped") !== "u-shaped") return;
		requestCounter += 1;
		currentRequestIndex = requestCounter;
		llmCallStartedAt = Date.now();
		appendSlmDebug({
			event: "llm-call-start",
			stage: "LLM",
			requestIndex: currentRequestIndex,
			messages: event.messages.length,
			contextChars: messagesTextLength(event.messages as Array<Record<string, unknown>>),
		});
	});

	// Per-request inbound compression: project old tool results into cached SLM summaries.
	// The transcript itself is never mutated - the runner clones messages, so this only
	// changes what the next LLM HTTP call sees.
	pi.on("context_with_system", async (event) => {
		const settings = pi.getSettings().uHarness;
		if ((settings?.pipeline ?? "u-shaped") !== "u-shaped") return undefined;
		if (settings?.slm?.perRequestCompression === false) return undefined;

		const messages = event.messages;
		const toolResultIndices = messages
			.map((message, index) => (message.role === "toolResult" ? index : -1))
			.filter((index) => index >= 0);
		const compressible = toolResultIndices.slice(0, -HISTORY_KEEP_RECENT_TOOL_RESULTS);
		if (compressible.length === 0) {
			appendSlmDebug({
				event: "history-skip",
				stage: "SLM compress",
				requestIndex: currentRequestIndex,
				reason: "tidak ada tool result lama yang layak (semua termasuk 2 terbaru)",
			});
			return undefined;
		}

		const output = [...messages];
		let charsBefore = 0;
		let charsAfter = 0;
		let freshCount = 0;
		let cacheHitCount = 0;
		try {
			const resolvedSettings = await resolveSettings(settings);
			const bridge = new UHarnessBridge(resolvedSettings ?? {});
			for (const index of compressible) {
				const message = output[index];
				if (message.role !== "toolResult") continue;
				const text = messageText(message);
				if (text.length < HISTORY_COMPRESS_MIN_CHARS) continue;
				const key = historyCacheKey(message);
				const cached = historyCache.get(key);
				if (cached !== undefined) {
					cacheHitCount += 1;
					charsBefore += text.length;
					charsAfter += cached.length;
					output[index] = { ...message, content: [{ type: "text", text: `[DIRINGKAS SLM] ${cached}` }] };
					appendSlmDebug({
						event: "history-compressed",
						stage: "SLM compress",
						requestIndex: currentRequestIndex,
						toolName: message.toolName,
						charsBefore: text.length,
						charsAfter: cached.length,
						cached: true,
					});
					continue;
				}
				const summary = (
					await bridge.callSlmDefault(buildHistoryCompressPrompt(message.toolName, text), "SLM compress")
				).slice(0, 1500);
				cachePut(historyCache, key, summary);
				freshCount += 1;
				charsBefore += text.length;
				charsAfter += summary.length;
				output[index] = { ...message, content: [{ type: "text", text: `[DIRINGKAS SLM] ${summary}` }] };
				appendSlmDebug({
					event: "history-compressed",
					stage: "SLM compress",
					requestIndex: currentRequestIndex,
					toolName: message.toolName,
					charsBefore: text.length,
					charsAfter: summary.length,
					cached: false,
				});
			}
		} catch (error) {
			// Compression is an optimization; any failure sends the original history untouched.
			appendSlmDebug({
				event: "agent-error",
				stage: "SLM compress",
				requestIndex: currentRequestIndex,
				error: error instanceof Error ? error.message : String(error),
			});
			return undefined;
		}
		if (freshCount === 0 && cacheHitCount === 0) {
			appendSlmDebug({
				event: "history-skip",
				stage: "SLM compress",
				requestIndex: currentRequestIndex,
				reason: "tidak ada tool result lama di atas ambang ukuran",
			});
			return undefined;
		}

		appendSlmDebug({
			event: "context-projected",
			stage: "SLM compress",
			requestIndex: currentRequestIndex,
			messagesIn: messages.length,
			compressed: freshCount,
			cacheHits: cacheHitCount,
			charsBefore,
			charsAfter,
		});
		return { messages: output };
	});

	// Per-request evidence + outbound decompression: after each assistant step, log the
	// call's token usage and expand the step's text against the brief (evidence only -
	// tool calls are never touched, so the loop keeps executing verbatim).
	pi.on("turn_end", async (event) => {
		const settings = pi.getSettings().uHarness;
		if ((settings?.pipeline ?? "u-shaped") !== "u-shaped") return;
		const message = event.message as { role?: string; usage?: Record<string, number>; content?: unknown };
		const usage = message.usage;
		appendSlmDebug({
			event: "llm-call-end",
			stage: "LLM",
			requestIndex: currentRequestIndex,
			turnIndex: event.turnIndex,
			ms: llmCallStartedAt !== undefined ? Date.now() - llmCallStartedAt : undefined,
			usage:
				usage !== undefined
					? {
							input: usage.input,
							output: usage.output,
							cacheRead: usage.cacheRead,
							cacheWrite: usage.cacheWrite,
							totalTokens: usage.totalTokens,
						}
					: undefined,
		});
		llmCallStartedAt = undefined;

		const pending = pendingTurn;
		if (!pending) return;
		if (settings?.slm?.perRequestDecompression === false) return;
		const text = messageText({ content: message.content });
		if (!text) {
			appendSlmDebug({
				event: "decompress-skip",
				stage: "SLM decompress",
				requestIndex: currentRequestIndex,
				reason: "langkah tanpa teks (pure tool call)",
			});
			return;
		}

		try {
			const resolvedSettings = await resolveSettings(settings);
			const bridge = new UHarnessBridge(resolvedSettings ?? {});
			const { output, verdict } = await bridge.decompressStep({
				brief: pending.brief,
				assistantOutput: text,
				requestIndex: currentRequestIndex,
			});
			decompressAccumulator.push(`### Request ${currentRequestIndex} (verdict: ${verdict})\n${output}`);
			if (bridge.settings.clm?.enabled !== false) {
				const memory = bridge.clm.loadMemory(pending.task);
				bridge.clm.saveMemory(
					bridge.clm.updateSection(memory, "DECOMPRESSED OUTPUT", decompressAccumulator.join("\n\n")),
				);
				appendSlmDebug({
					event: "clm-update",
					stage: "SLM decompress",
					requestIndex: currentRequestIndex,
					section: "DECOMPRESSED OUTPUT",
					path: bridge.clm.workingMemoryPath,
				});
			}
		} catch (error) {
			// Decompression is evidence-only; never break the agent loop because of it.
			appendSlmDebug({
				event: "agent-error",
				stage: "SLM decompress",
				requestIndex: currentRequestIndex,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	});
}
