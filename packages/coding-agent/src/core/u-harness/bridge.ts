import type { UHarnessSettings } from "../settings-schema.ts";
import { ContextLanguageModel } from "./clm.ts";
import { buildInboundCompressorPrompt, parseArchitecturalBrief } from "./compressor.ts";
import { appendSlmDebug } from "./debug-log.ts";
import { extractCanonicalPatches, formatTripletPrompt } from "./decompressor.ts";
import { resolveSlmEndpoint } from "./endpoint.ts";
import type { RepoFile, TurnExecutionInput, TurnExecutionResult, UHarnessTelemetry } from "./types.ts";

/**
 * Parse the first complete JSON object from an SLM response body.
 * Some gateways append trailing data after the chat completion object, which
 * breaks `response.json()` with "Unexpected non-whitespace character after JSON".
 */
function parseSlmResponseJson(body: string): unknown {
	try {
		return JSON.parse(body);
	} catch {
		// Fall through to scanning for the first complete object.
	}
	const start = body.indexOf("{");
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let index = start; start >= 0 && index < body.length; index++) {
		const character = body[index];
		if (inString) {
			if (escaped) escaped = false;
			else if (character === "\\") escaped = true;
			else if (character === '"') inString = false;
			continue;
		}
		if (character === '"') inString = true;
		else if (character === "{") depth++;
		else if (character === "}") {
			depth--;
			if (depth !== 0) continue;
			const candidate = body.slice(start, index + 1);
			try {
				return JSON.parse(candidate);
			} catch {
				// Malformed candidate (for example unquoted keys); keep scanning.
				depth = 0;
			}
		}
	}
	const preview = body.slice(0, 120).replace(/\s+/u, " ");
	throw new Error(`SLM response was not valid JSON: ${preview}`);
}

/**
 * U-Harness Provider Bridge.
 * Orchestrates dual-model asymmetric computing (SLM + Cloud) or delegates to baseline monolithic mode.
 */
export class UHarnessBridge {
	readonly settings: UHarnessSettings;
	readonly clm: ContextLanguageModel;

	constructor(settings: UHarnessSettings = {}) {
		this.settings = settings;
		const memoryPath = settings.clm?.workingMemoryPath ?? ".context/working_memory.md";
		this.clm = new ContextLanguageModel(memoryPath);
	}

	/**
	 * Default caller for SLM via OpenAI-compatible REST endpoint (e.g. vLLM or any
	 * provider registered in models.json).
	 */
	async callSlmDefault(prompt: string): Promise<string> {
		const endpoint = await resolveSlmEndpoint(this.settings);
		const temperature = this.settings.slm?.temperature ?? 0.2;
		const maxTokens = this.settings.slm?.maxTokens ?? 1024;

		const headers: Record<string, string> = { "Content-Type": "application/json" };
		if (endpoint.apiKey) headers.Authorization = `Bearer ${endpoint.apiKey}`;

		const privacyMark = "trains on request data";
		// Gateways like 9router route to an upstream pool and reject requests that land
		// on a training-on-data upstream; one retry usually lands on an allowed slot.
		for (let attempt = 1; attempt <= 2; attempt++) {
			const startedAt = Date.now();
			appendSlmDebug({
				event: "request",
				baseUrl: endpoint.baseUrl,
				model: endpoint.model,
				attempt,
				promptChars: prompt.length,
				promptPreview: prompt.slice(0, 200),
			});
			let response: Response;
			try {
				response = await fetch(`${endpoint.baseUrl}/chat/completions`, {
					method: "POST",
					headers,
					body: JSON.stringify({
						model: endpoint.model,
						messages: [{ role: "user", content: prompt }],
						temperature,
						max_tokens: maxTokens,
					}),
				});
			} catch (error) {
				const reason = error instanceof Error ? error.message : String(error);
				appendSlmDebug({ event: "fetch-error", baseUrl: endpoint.baseUrl, attempt, error: reason });
				throw new Error(`SLM request to ${endpoint.baseUrl} failed: ${reason}`);
			}

			if (!response.ok) {
				const errorText = await response.text();
				appendSlmDebug({
					event: "http-error",
					baseUrl: endpoint.baseUrl,
					model: endpoint.model,
					attempt,
					status: response.status,
					bodyPreview: errorText.slice(0, 300),
				});
				if (response.status === 400 && errorText.includes(privacyMark)) {
					if (attempt === 1) continue;
					throw new Error(
						`SLM call blocked by the gateway privacy setting from ${endpoint.baseUrl} (model ${endpoint.model}): allow "paid endpoints that train on request data" in the gateway's Privacy settings`,
					);
				}
				throw new Error(`SLM call failed (${response.status}) from ${endpoint.baseUrl}: ${errorText}`);
			}

			const raw = await response.text();
			const data = parseSlmResponseJson(raw) as {
				choices?: Array<{ message?: { content?: string; reasoning_content?: string } }>;
			};
			// Thinking models answer in reasoning_content and leave content empty; prefer content when present.
			const message = data.choices?.[0]?.message;
			const result = message?.content || message?.reasoning_content || "";
			appendSlmDebug({
				event: "response",
				baseUrl: endpoint.baseUrl,
				model: endpoint.model,
				attempt,
				ms: Date.now() - startedAt,
				resultChars: result.length,
				resultPreview: result.slice(0, 200),
				usedReasoningContent: !message?.content && result.length > 0,
			});
			return result;
		}
		throw new Error(`SLM request to ${endpoint.baseUrl} failed: retries exhausted`);
	}

	/**
	 * Runs the inbound compression stage only and returns the architectural brief.
	 * This is the runtime entry point used when the cloud reasoner is the normal agent model.
	 */
	async compressInbound(
		task: string,
		files: RepoFile[],
		callSlm: (prompt: string) => Promise<string> = (prompt) => this.callSlmDefault(prompt),
	): Promise<string> {
		const prompt = buildInboundCompressorPrompt(task, files);
		const raw = await callSlm(prompt);
		return parseArchitecturalBrief(raw).raw;
	}

	/**
	 * Executes one turn of coding reasoning.
	 */
	async executeTurn(input: TurnExecutionInput): Promise<TurnExecutionResult> {
		const startTime = Date.now();
		const pipelineMode = this.settings.pipeline ?? "u-shaped";

		if (pipelineMode === "baseline") {
			// Mode Monolitik Biasa: Panggil cloud reasoner secara langsung
			const combinedPrompt = `${input.task}\n\nKonteks Berkas:\n${input.files
				.map((f) => `### FILE: ${f.path}\n${f.content}`)
				.join("\n\n")}`;

			const finalOutput = await input.callCloudReasoner(combinedPrompt);
			const patches = extractCanonicalPatches(
				finalOutput,
				this.settings.tripletConfluence?.canonicalMarker ?? "### FILE:",
			);

			const telemetry: UHarnessTelemetry = {
				durationMs: Date.now() - startTime,
				slmInboundTokens: 0,
				cloudReasonerTokens: Math.ceil(combinedPrompt.length / 4),
				slmOutboundTokens: 0,
				pipelineMode: "baseline",
			};

			return {
				pipelineMode: "baseline",
				patches,
				finalOutput,
				telemetry,
			};
		}

		// Mode U-Shaped (U-Harness)
		const slmCaller = input.callSlm ?? ((prompt: string) => this.callSlmDefault(prompt));

		// 1. Stage 1: Inbound Compression via SLM
		const compressionPrompt = buildInboundCompressorPrompt(input.task, input.files);
		const rawBrief = await slmCaller(compressionPrompt);
		const architecturalBrief = parseArchitecturalBrief(rawBrief);

		if (this.settings.clm?.enabled !== false) {
			const mem = this.clm.loadMemory(input.task);
			const updated = this.clm.updateSection(mem, "ARCHITECTURAL BRIEF", architecturalBrief.raw);
			this.clm.saveMemory(updated);
		}

		// 2. Stage 2: Core Reasoning via Cloud Engine (Dense Blueprint)
		const cloudPrompt = `SPESIFIKASI TUGAS:
${input.task}

ARCHITECTURAL BRIEF DARI SLM:
${architecturalBrief.raw}

Hasilkan BLUEPRINT SOLUSI terstruktur berupa logika algoritma dan rancangan fungsi. Jangan tulis kode repetitif.`;

		const solutionBlueprint = await input.callCloudReasoner(cloudPrompt);

		// 3. Stage 3: Outbound Decompression via SLM (Triplet Confluence)
		const tripletPrompt = formatTripletPrompt({
			originalFiles: input.files,
			architecturalBrief: architecturalBrief.raw,
			solutionBlueprint,
		});

		const decompressedOutput = await slmCaller(tripletPrompt);
		const patches = extractCanonicalPatches(
			decompressedOutput,
			this.settings.tripletConfluence?.canonicalMarker ?? "### FILE:",
		);

		const telemetry: UHarnessTelemetry = {
			durationMs: Date.now() - startTime,
			slmInboundTokens: Math.ceil(compressionPrompt.length / 4),
			cloudReasonerTokens: Math.ceil(cloudPrompt.length / 4),
			slmOutboundTokens: Math.ceil(tripletPrompt.length / 4),
			pipelineMode: "u-shaped",
		};

		return {
			pipelineMode: "u-shaped",
			architecturalBrief: architecturalBrief.raw,
			solutionBlueprint,
			patches,
			finalOutput: decompressedOutput,
			telemetry,
		};
	}
}
