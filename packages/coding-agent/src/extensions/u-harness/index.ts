/**
 * Runtime integration for the U-Harness per-request flow.
 *
 * The whole system is ONE coding agent (no sub-agents). Every LLM request inside
 * the agent loop is intercepted by a fixed flow:
 *   Entity 1: the raw request (transcript) the harness is about to send
 *   Entity 2: SLM compresses that actual request against the CLM ledger
 *   Entity 3: the (cloud) LLM receives the compressed request
 *   Entity 4: SLM expands the LLM's core answer into the full response the
 *             harness executes (text plus canonical ### FILE write tool calls)
 *   Entity 5: the harness executes those tool calls / shows the answer
 *   Entity 6: CLM ledger kept in-place across requests
 *
 * All stage decisions are recorded in the U-Harness debug log when `UH_SLM_DEBUG=1`
 * (or `uh --debug`). When the SLM provider is `janas`, the SLM is an external Janas
 * server managed by this extension and stopped again on session shutdown.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI } from "../../core/extensions/types.ts";
import type { UHarnessSettings } from "../../core/settings-schema.ts";
import { UHarnessBridge } from "../../core/u-harness/bridge.ts";
import {
	buildRequestCompressPrompt,
	isPlaceholderBrief,
	parseCompressedRequest,
} from "../../core/u-harness/compressor.ts";
import {
	appendSlmDebug,
	isSlmDebugEnabled,
	setSlmDebugRunId,
	slmDebugLogPath,
} from "../../core/u-harness/debug-log.ts";
import { type DebugUiServer, getRunningDebugUiUrl, startDebugUiServer } from "../../core/u-harness/debug-server.ts";
import {
	buildRequestExpandPrompt,
	extractCanonicalPatches,
	parseVerdict,
	patchesToToolCalls,
	stripVerdictLine,
} from "../../core/u-harness/decompressor.ts";
import { JanasServer } from "../../core/u-harness/janas.ts";

/** Requests below this size do not benefit from a compression round-trip. */
const REQUEST_COMPRESS_MIN_CHARS = 400;
/** Keep at most this many characters of raw context in the decompression triplet. */
const RAW_CONTEXT_MAX_CHARS = 6000;
/** Upper bound on cached compressed requests (FIFO). */
const REQUEST_CACHE_MAX_ENTRIES = 100;
/** Footer status key so users can see the flow live in the terminal. */
const STATUS_KEY = "u-harness";

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
	return messages.reduce((total, message) => total + messageText(message as { content?: unknown }).length, 0);
}

/** Textual rendering of a message list — this IS the raw request (Entity 1). */
function renderRawRequest(messages: Array<Record<string, unknown>>): string {
	const parts: string[] = [];
	for (const message of messages) {
		const role = String(message.role);
		if (role === "system") continue;
		const text = messageText(message as { content?: unknown });
		if (text) parts.push(`[${role}] ${text}`);
		else if (role === "toolResult" && message.toolName)
			parts.push(`[toolResult:${String(message.toolName)}] (tanpa teks)`);
		else if (role === "assistant") parts.push("[assistant] (tool call)");
	}
	return parts.join("\n\n");
}

/** Latest user / tool-result context for the decompression triplet (Entity 4 input). */
function recentRawContext(messages: Array<Record<string, unknown>>): string {
	const texts: string[] = [];
	for (let index = messages.length - 1; index >= 0; index--) {
		if (texts.join("\n\n").length >= RAW_CONTEXT_MAX_CHARS) break;
		const message = messages[index];
		const role = String(message.role);
		if (role !== "toolResult" && role !== "user") continue;
		const text = messageText(message as { content?: unknown });
		if (!text) continue;
		const label = role === "toolResult" ? `${message.toolName ?? "tool"} result` : "user";
		texts.unshift(`--- ${label} ---\n${text}`);
	}
	return texts.join("\n\n").slice(-RAW_CONTEXT_MAX_CHARS);
}

interface RequestSummary {
	index: number;
	compressed: boolean;
	expanded: boolean;
	verdict?: string;
	savedChars: number;
}

interface PendingFlow {
	compressedRequest: string;
	rawContext: string;
	charsBefore: number;
	charsAfter: number;
	requestIndex: number;
}

export default function uHarnessExtension(pi: ExtensionAPI): void {
	let janasServer: JanasServer | undefined;
	let debugUi: DebugUiServer | undefined;
	let debugUiAnnounced = false;
	let runCounter = 0;
	let requestCounter = 0;
	let currentRequestIndex: number | undefined;
	let llmCallStartedAt: number | undefined;
	/** Entity 2 output for the in-flight request; drives Entity 4 on message_end. */
	let pendingFlow: PendingFlow | undefined;
	const requestCache = new Map<string, string>();
	let requestSummaries: RequestSummary[] = [];

	const resolveSettings = async (settings: UHarnessSettings | undefined): Promise<UHarnessSettings | undefined> => {
		if ((settings?.slm?.provider ?? "openai") !== "janas") return settings;
		janasServer ??= new JanasServer(settings ?? {});
		const baseUrl = await janasServer.start();
		return { ...settings, slm: { ...settings?.slm, baseUrl } };
	};

	const setStage = (
		ctx: { ui?: { setStatus?: (key: string, text: string | undefined) => void } },
		text: string | undefined,
	) => {
		ctx.ui?.setStatus?.(STATUS_KEY, text);
	};

	pi.on("session_shutdown", async () => {
		await janasServer?.stop();
		janasServer = undefined;
		await debugUi?.close();
		debugUi = undefined;
	});

	// Debug UI (http://127.0.0.1:4949 by default) so `uh --debug` shows the flow live.
	if (isSlmDebugEnabled()) {
		const preferredPort = Number(process.env.UH_DEBUG_UI_PORT ?? 4949);
		startDebugUiServer(slmDebugLogPath(), Number.isFinite(preferredPort) ? preferredPort : undefined)
			.then((server) => {
				debugUi = server;
				appendSlmDebug({ event: "debug-ui", url: server.url });
			})
			.catch(() => {
				// The UI is a convenience; pipeline logging keeps working without it.
			});
	}

	pi.registerCommand("uh", {
		description: "Show U-Harness pipeline status (flow, ledger, debug log, UI)",
		handler: async (_args, ctx) => {
			const settings = pi.getSettings().uHarness;
			const mode = settings?.pipeline ?? "u-shaped";
			const ledgerPath = settings?.clm?.workingMemoryPath ?? ".context/working_memory.md";
			const uiUrl = debugUi?.url ?? getRunningDebugUiUrl();
			ctx.ui.notify(
				[
					`U-Harness: pipeline ${mode}, ${requestCounter} request pada ${runCounter} run`,
					`Flow per request: compress (SLM) -> LLM -> decompress (SLM), 1 agent tanpa sub-agent`,
					`CLM ledger: ${ledgerPath}`,
					isSlmDebugEnabled()
						? `Debug log: ${slmDebugLogPath()}${uiUrl ? ` | UI: ${uiUrl}` : ""}`
						: "Debug log mati (aktifkan dengan: uh --debug)",
				].join("\n"),
			);
		},
	});

	// Entity 1: mark the start of one LLM request and capture its raw size.
	pi.on("context", async (event) => {
		const settings = pi.getSettings().uHarness;
		if ((settings?.pipeline ?? "u-shaped") !== "u-shaped") return;
		requestCounter += 1;
		currentRequestIndex = requestCounter;
		pendingFlow = undefined;
		llmCallStartedAt = Date.now();
		appendSlmDebug({
			event: "llm-call-start",
			stage: "LLM",
			requestIndex: currentRequestIndex,
			messages: event.messages.length,
			contextChars: messagesTextLength(event.messages as Array<Record<string, unknown>>),
		});
	});

	// Entity 2 + Entity 6: compress the ACTUAL request with the SLM against the CLM
	// ledger. The LLM receives the compressed request; the transcript is untouched.
	pi.on("context_with_system", async (event, ctx) => {
		const settings = pi.getSettings().uHarness;
		if ((settings?.pipeline ?? "u-shaped") !== "u-shaped") return undefined;
		if (settings?.slm?.perRequestCompression === false) return undefined;

		const requestIndex = currentRequestIndex;
		if (requestIndex === undefined) return undefined;
		const messages = event.messages as Array<Record<string, unknown>>;
		const rawRequest = renderRawRequest(messages);
		const startedAt = Date.now();
		setStage(ctx, `SLM compress (request #${requestIndex})…`);

		const ledgerPath = settings?.clm?.workingMemoryPath ?? ".context/working_memory.md";
		const ledger = settings?.clm?.enabled === false ? "" : readLedger(ledgerPath);

		if (rawRequest.length < REQUEST_COMPRESS_MIN_CHARS) {
			appendSlmDebug({
				event: "request-skip",
				stage: "SLM compress",
				requestIndex,
				reason: `request mentah ${rawRequest.length} char di bawah ambang ${REQUEST_COMPRESS_MIN_CHARS}`,
			});
			requestSummaries.push({ index: requestIndex, compressed: false, expanded: false, savedChars: 0 });
			setStage(ctx, undefined);
			return undefined;
		}

		try {
			const resolvedSettings = await resolveSettings(settings);
			const bridge = new UHarnessBridge(resolvedSettings ?? {});
			const cacheKey = rawRequest;
			const cached = requestCache.get(cacheKey);
			let compressed: string;
			if (cached !== undefined) {
				compressed = cached;
				appendSlmDebug({ event: "request-cache-hit", stage: "SLM compress", requestIndex });
			} else {
				const raw = await bridge.callSlmDefault(
					buildRequestCompressPrompt({ rawRequest, ledger }),
					"SLM compress",
					requestIndex,
				);
				compressed = parseCompressedRequest(raw);
				if (!compressed.trim()) throw new Error("SLM mengembalikan request padat kosong");
				if (isPlaceholderBrief(compressed)) {
					throw new Error("SLM mengembalikan template/placeholder, bukan request padat nyata");
				}
				if (requestCache.size >= REQUEST_CACHE_MAX_ENTRIES) {
					const oldest = requestCache.keys().next().value;
					if (oldest !== undefined) requestCache.delete(oldest);
				}
				requestCache.set(cacheKey, compressed);
			}

			appendSlmDebug({
				event: "request-compressed",
				stage: "SLM compress",
				requestIndex,
				charsBefore: rawRequest.length,
				charsAfter: compressed.length,
				cached: cached !== undefined,
				ms: Date.now() - startedAt,
				output: compressed.slice(0, 8000),
				truncated: compressed.length > 8000,
			});
			requestSummaries.push({
				index: requestIndex,
				compressed: true,
				expanded: false,
				savedChars: Math.max(0, rawRequest.length - compressed.length),
			});

			if (settings?.clm?.enabled !== false) {
				const taskLine = compressed.split("\n").slice(0, 3).join(" ").slice(0, 200);
				const existing = readLedger(ledgerPath);
				const withoutCurrent = stripLedgerSection(existing, "CURRENT TASK");
				const withoutLastRequest = stripLedgerSection(withoutCurrent, `REQUEST TERAKHIR (#${requestIndex})`);
				writeLedger(
					ledgerPath,
					`## CURRENT TASK\n${taskLine}\n\n## REQUEST TERAKHIR (#${requestIndex})\n${compressed}\n\n${withoutLastRequest}`.trim() +
						"\n",
				);
				appendSlmDebug({ event: "clm-update", stage: "SLM compress", requestIndex, path: ledgerPath });
			}

			pendingFlow = {
				compressedRequest: compressed,
				rawContext: recentRawContext(messages),
				charsBefore: rawRequest.length,
				charsAfter: compressed.length,
				requestIndex,
			};

			// Entity 3: the LLM receives the compressed request (+ ledger notes).
			const projected: AgentMessage[] = [];
			const systemMessage = messages[0]?.role === "system" ? (messages[0] as AgentMessage) : undefined;
			if (systemMessage) projected.push(systemMessage);
			projected.push({
				role: "user",
				content: [
					{
						type: "text",
						text: `${compressed}\n\n[CATATAN KONTEKS SESI]\n${ledger || "(kosong)"}`,
					},
				],
			} as AgentMessage);
			setStage(ctx, `LLM (request #${requestIndex})…`);
			return { messages: projected };
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			appendSlmDebug({
				event: "request-bypass",
				stage: "SLM compress",
				requestIndex,
				reason: `kompresi gagal: ${reason}`,
			});
			requestSummaries.push({ index: requestIndex, compressed: false, expanded: false, savedChars: 0 });
			setStage(ctx, undefined);
			ctx.ui.notify(
				`U-Harness: kompresi request #${requestIndex} gagal, request asli dikirim (${reason})`,
				"warning",
			);
			return undefined;
		}
	});

	// Entity 4 + Entity 5 boundary: expand the LLM's core answer into the response
	// the harness executes. Canonical ### FILE blocks become write tool calls;
	// everything happens before the runner executes tool calls from this message.
	pi.on("message_end", async (event, ctx) => {
		const settings = pi.getSettings().uHarness;
		if ((settings?.pipeline ?? "u-shaped") !== "u-shaped") return undefined;
		if (settings?.slm?.perRequestDecompression === false) return undefined;
		if (event.message.role !== "assistant") return undefined;
		const flow = pendingFlow;
		pendingFlow = undefined;
		if (!flow) return undefined;

		const message = event.message as { content?: unknown };
		const coreAnswer = messageText(message);
		if (!coreAnswer) {
			appendSlmDebug({
				event: "request-bypass",
				stage: "SLM decompress",
				requestIndex: flow.requestIndex,
				reason: "langkah tanpa teks (pure tool call) — tool calls LLM dipakai apa adanya",
			});
			return undefined;
		}

		const startedAt = Date.now();
		setStage(ctx, `SLM decompress (request #${flow.requestIndex})…`);
		try {
			const resolvedSettings = await resolveSettings(settings);
			const bridge = new UHarnessBridge(resolvedSettings ?? {});
			const raw = await bridge.callSlmDefault(
				buildRequestExpandPrompt({
					rawContext: flow.rawContext,
					compressedRequest: flow.compressedRequest,
					coreAnswer,
				}),
				"SLM decompress",
				flow.requestIndex,
			);
			const verdict = parseVerdict(raw);
			const expandedText = stripVerdictLine(raw);
			const patches = extractCanonicalPatches(
				expandedText,
				settings?.tripletConfluence?.canonicalMarker ?? "### FILE:",
			);
			appendSlmDebug({
				event: "request-expanded",
				stage: "SLM decompress",
				requestIndex: flow.requestIndex,
				patches: patches.length,
				verdict,
				ms: Date.now() - startedAt,
				outputChars: expandedText.length,
				output: expandedText.slice(0, 8000),
				truncated: expandedText.length > 8000,
			});
			const summary = requestSummaries.find((entry) => entry.index === flow.requestIndex);
			if (summary) {
				summary.expanded = true;
				summary.verdict = verdict;
			}
			if (verdict === "FAIL") {
				appendSlmDebug({
					event: "request-bypass",
					stage: "SLM decompress",
					requestIndex: flow.requestIndex,
					reason: "verdict FAIL — balasan LLM asli dipakai, hasil dekompresi dibuang",
				});
				setStage(ctx, undefined);
				return undefined;
			}

			const ledgerPath = settings?.clm?.workingMemoryPath ?? ".context/working_memory.md";
			if (settings?.clm?.enabled !== false && patches.length > 0) {
				const previous = readLedger(ledgerPath);
				const patchLines = patches.map((patch) => `- ${patch.filePath} (${patch.content.length} chars)`).join("\n");
				writeLedger(
					ledgerPath,
					`${previous}\n## PATCH TERAKHIR (#${flow.requestIndex}, verdict ${verdict})\n${patchLines}\n`,
				);
				appendSlmDebug({
					event: "clm-update",
					stage: "SLM decompress",
					requestIndex: flow.requestIndex,
					path: ledgerPath,
				});
			}

			// Entity 5: the harness executes THIS content, not the LLM's raw answer.
			const content: Array<Record<string, unknown>> = [];
			if (expandedText) content.push({ type: "text", text: expandedText });
			const originalParts = (message.content as Array<Record<string, unknown>>) ?? [];
			const llmToolCalls = originalParts.filter((part) => part.type === "toolCall");
			if (patches.length > 0) {
				content.push(...(patchesToToolCalls(patches) as Array<Record<string, unknown>>));
			}
			// Never drop the LLM's own tool calls (reads, edits, bash) — merge, not replace.
			content.push(...llmToolCalls);
			setStage(ctx, undefined);
			return { message: { ...message, content } as unknown as AgentMessage };
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			appendSlmDebug({
				event: "request-bypass",
				stage: "SLM decompress",
				requestIndex: flow.requestIndex,
				reason: `dekompresi gagal: ${reason}`,
			});
			setStage(ctx, undefined);
			ctx.ui.notify(
				`U-Harness: dekompresi request #${flow.requestIndex} gagal, balasan LLM asli dipakai (${reason})`,
				"warning",
			);
			return undefined;
		}
	});

	// Per-request token evidence + compact end-of-turn summary for the user.
	pi.on("turn_end", async (event, ctx) => {
		const settings = pi.getSettings().uHarness;
		if ((settings?.pipeline ?? "u-shaped") !== "u-shaped") return;
		const usage = (event.message as { usage?: Record<string, number> }).usage;
		appendSlmDebug({
			event: "llm-call-end",
			stage: "LLM",
			requestIndex: currentRequestIndex,
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

		const summaries = requestSummaries;
		requestSummaries = [];
		setStage(ctx, undefined);
		if (summaries.length === 0) return;
		if (!summaries.some((entry) => entry.compressed || entry.expanded)) return;
		const compressed = summaries.filter((entry) => entry.compressed);
		const saved = summaries.reduce((total, entry) => total + entry.savedChars, 0);
		const detail = summaries
			.map(
				(entry) =>
					`#${entry.index}${entry.compressed ? " dikompres" : ""}${entry.expanded ? " didekompres" : ""}${entry.verdict ? ` (${entry.verdict})` : ""}`,
			)
			.join(", ");
		ctx.ui.notify(
			`U-Harness: ${summaries.length} request | dikompres ${compressed.length} | −${saved} chars | ${detail}`,
		);
	});

	// One run = one user prompt (N internal requests). Reset per-run evidence here.
	pi.on("before_agent_start", async (event, ctx) => {
		const settings = pi.getSettings().uHarness;
		if ((settings?.pipeline ?? "u-shaped") !== "u-shaped") return;
		if (event.messageType !== "user" || !event.prompt.trim()) return;
		runCounter += 1;
		setSlmDebugRunId(runCounter);
		requestCounter = 0;
		currentRequestIndex = undefined;
		pendingFlow = undefined;
		requestSummaries = [];
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
	});
}

/** Removes one `## <title>` section from ledger content (CLM in-place edit). */
function stripLedgerSection(content: string, title: string): string {
	const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const regex = new RegExp(`\\n?\\n## ${escaped}\\n[\\s\\S]*?(?=\\n## |$)`, "g");
	return content.replace(regex, "").trim();
}

/** CLM ledger read that never throws (Entity 6 input). */
function readLedger(path: string): string {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return "";
	}
}

/** CLM ledger in-place write that never throws (Entity 6 output). */
function writeLedger(path: string, content: string): void {
	try {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, content, "utf8");
	} catch {
		// The ledger aids later requests; failures must not break the agent loop.
	}
}
