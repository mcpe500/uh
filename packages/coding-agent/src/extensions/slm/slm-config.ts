/**
 * Helpers for reading, listing, and persisting U-Harness SLM configuration.
 *
 * The SLM is intentionally a small OpenAI-compatible endpoint. These helpers keep the
 * `/slm-*` extension commands thin and testable without involving the extension runtime.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { UHarnessSettings } from "../../core/settings-schema.ts";
import { stripBom } from "../../utils/text.ts";

export interface SlmProviderInfo {
	provider: string;
	baseUrl: string;
	model: string;
}

export interface SlmSettingsPatch {
	baseUrl?: string;
	model?: string;
	apiKey?: string;
	temperature?: number;
	maxTokens?: number;
}

export function getSlmProviderInfo(settings: UHarnessSettings | undefined): SlmProviderInfo {
	return {
		provider: settings?.slm?.provider ?? "openai",
		baseUrl: settings?.slm?.baseUrl ?? "http://localhost:8000/v1",
		model: settings?.slm?.model ?? "Qwen/Qwen2.5-Coder-1.5B-Instruct",
	};
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
