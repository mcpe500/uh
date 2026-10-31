/**
 * Helpers for reading, listing, and persisting U-Harness SLM configuration.
 *
 * The SLM is intentionally a small OpenAI-compatible endpoint. These helpers keep the
 * `/slm-*` extension commands thin and testable without involving the extension runtime.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { getModelsPath } from "../../config.ts";
import { ModelConfig } from "../../core/model-config.ts";
import type { UHarnessSettings } from "../../core/settings-schema.ts";
import { stripBom } from "../../utils/text.ts";

export interface SlmProviderInfo {
	provider: string;
	baseUrl: string;
	model: string;
}

export interface SlmSettingsPatch {
	provider?: string;
	baseUrl?: string;
	model?: string;
	apiKey?: string;
	temperature?: number;
	maxTokens?: number;
	executablePath?: string;
}

/** One provider entry from models.json: display name, endpoint, and model ids. */
export interface SlmCatalogEntry {
	provider: string;
	name: string | undefined;
	baseUrl: string | undefined;
	models: string[];
}

export function getSlmProviderInfo(settings: UHarnessSettings | undefined): SlmProviderInfo {
	return {
		provider: settings?.slm?.provider ?? "openai",
		baseUrl: settings?.slm?.baseUrl ?? "http://localhost:8000/v1",
		model: settings?.slm?.model ?? "Qwen/Qwen2.5-Coder-1.5B-Instruct",
	};
}

/**
 * Load the models.json catalog that `/models` reads, validated like any other consumer.
 * Throws when models.json exists but fails to load or validate.
 */
export async function loadSlmCatalog(modelsJsonPath?: string): Promise<SlmCatalogEntry[]> {
	const config = await ModelConfig.load(modelsJsonPath ?? getModelsPath());
	const error = config.getError();
	if (error) throw new Error(error);
	return config.getProviderIds().map((providerId) => {
		const provider = config.getProvider(providerId);
		return {
			provider: providerId,
			name: provider?.name,
			baseUrl: provider?.baseUrl,
			models: (provider?.models ?? []).map((model) => model.id),
		};
	});
}

export interface ParsedSlmSetArgs {
	provider?: string;
	model?: string;
	executablePath?: string;
}

/**
 * Parse `/slm-set` arguments.
 * Supported forms: `<model>`, `<provider> <model>`, or
 * `<provider> <model> --executable <path>`.
 */
export function parseSlmSetArgs(input: string): ParsedSlmSetArgs | undefined {
	const tokens = input.trim().split(/\s+/u).filter(Boolean);
	if (tokens.length === 0) return undefined;
	const executableFlagIndex = tokens.indexOf("--executable");
	const executablePath = executableFlagIndex >= 0 ? tokens[executableFlagIndex + 1] : undefined;
	const positional = tokens.filter(
		(token, index) => token !== "--executable" && (executableFlagIndex < 0 || index !== executableFlagIndex + 1),
	);
	if (positional.length === 0) return undefined;
	if (positional.length === 1) return { model: positional[0] };
	const [provider, model] = positional;
	return { provider, model, ...(executablePath ? { executablePath } : {}) };
}

function authHeaders(apiKey: string | undefined): Record<string, string> {
	if (!apiKey || apiKey === "none") return {};
	return { Authorization: `Bearer ${apiKey}` };
}

/** Fetch the OpenAI-compatible model list exposed by the configured SLM endpoint. */
export async function listSlmModels(settings: UHarnessSettings | undefined, signal?: AbortSignal): Promise<string[]> {
	const baseUrl = (settings?.slm?.baseUrl ?? "http://localhost:8000/v1").replace(/\/$/, "");
	const response = await fetch(`${baseUrl}/models`, {
		headers: authHeaders(settings?.slm?.apiKey),
		signal,
	});
	if (!response.ok) throw new Error(`SLM model list failed: ${response.status}`);
	const data = (await response.json()) as unknown;
	const items = Array.isArray(data)
		? data
		: typeof data === "object" && data !== null && Array.isArray((data as { data?: unknown }).data)
			? (data as { data: unknown[] }).data
			: [];
	return items
		.filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null && "id" in item)
		.map((item) => String(item.id));
}

/** Merge a partial SLM settings patch into a settings.json file on disk. */
export function setSlmSettings(settingsPath: string, patch: SlmSettingsPatch): void {
	const raw = existsSync(settingsPath) ? readFileSync(settingsPath, "utf8") : "{}";
	const parsed = JSON.parse(stripBom(raw)) as Record<string, unknown>;
	const uHarness = { ...(parsed.uHarness as Record<string, unknown> | undefined) };
	const slm = { ...(uHarness.slm as Record<string, unknown> | undefined), ...patch };
	uHarness.slm = slm;
	parsed.uHarness = uHarness;
	mkdirSync(dirname(settingsPath), { recursive: true });
	writeFileSync(settingsPath, `${JSON.stringify(parsed, null, 2)}\n`);
}
