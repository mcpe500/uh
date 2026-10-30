import type { UHarnessSettings } from "../settings-schema.ts";
import { ContextLanguageModel } from "./clm.ts";
import { buildInboundCompressorPrompt, parseArchitecturalBrief } from "./compressor.ts";
import { extractCanonicalPatches, formatTripletPrompt } from "./decompressor.ts";
import type { RepoFile, TurnExecutionInput, TurnExecutionResult, UHarnessTelemetry } from "./types.ts";

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
	 * Default caller for SLM via OpenAI-compatible REST endpoint (e.g. vLLM).
	 */
	async callSlmDefault(prompt: string): Promise<string> {
		const baseUrl = this.settings.slm?.baseUrl ?? "http://localhost:8000/v1";
		const model = this.settings.slm?.model ?? "Qwen/Qwen2.5-Coder-1.5B-Instruct";
		const apiKey = this.settings.slm?.apiKey ?? "none";
		const temperature = this.settings.slm?.temperature ?? 0.2;
		const maxTokens = this.settings.slm?.maxTokens ?? 1024;

		const response = await fetch(`${baseUrl}/chat/completions`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${apiKey}`,
			},
			body: JSON.stringify({
				model,
				messages: [{ role: "user", content: prompt }],
				temperature,
				max_tokens: maxTokens,
			}),
		});

		if (!response.ok) {
			const errorText = await response.text();
			throw new Error(`SLM vLLM call failed (${response.status}): ${errorText}`);
		}

		const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
		return data.choices?.[0]?.message?.content ?? "";
	}

	/**
	 * Runs the inbound compression stage only and returns the architectural brief.
	 * This is the runtime entry point used when the cloud reasoner is the normal agent model.
	 */
	async compressInbound(task: string, files: RepoFile[]): Promise<string> {
		const prompt = buildInboundCompressorPrompt(task, files);
		const raw = await this.callSlmDefault(prompt);
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
