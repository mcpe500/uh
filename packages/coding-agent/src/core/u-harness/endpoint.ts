/**
 * Resolve the SLM REST endpoint for the U-Harness bridge.
 *
 * Explicit `slm.baseUrl`/`apiKey`/`model` in settings win; values left at their
 * defaults fall back to the provider named by `slm.provider` in models.json (the
 * same catalog `/models` reads), so a provider registered there needs no duplicated
 * endpoint or credentials in settings.json.
 */
import { getModelsPath } from "../../config.ts";
import { ModelConfig } from "../model-config.ts";
import { resolveConfigValue } from "../resolve-config-value.ts";
import { SETTINGS_DEFAULTS } from "../settings-defaults.ts";
import type { UHarnessSettings } from "../settings-schema.ts";

/** One resolved SLM endpoint for `callSlmDefault`. */
export interface SlmEndpoint {
	baseUrl: string;
	apiKey: string | undefined;
	model: string;
}

/** True when the settings value is missing or still the schema default (unset by the user). */
function unset(value: string | undefined, fallback: string): boolean {
	return value === undefined || value === fallback;
}

/** Resolve apiKey values that are literal, `$ENV`, or `!command`; `none` means no auth. */
function resolveConfiguredApiKey(configured: string | undefined): string | undefined {
	if (!configured || configured === "none") return undefined;
	return resolveConfigValue(configured);
}

/**
 * Resolve the SLM endpoint: settings first, then the models.json provider entry.
 * Throws when neither yields a baseUrl, naming what to configure.
 */
export async function resolveSlmEndpoint(
	settings: UHarnessSettings | undefined,
	modelsJsonPath?: string,
): Promise<SlmEndpoint> {
	const defaults = SETTINGS_DEFAULTS.uHarness.slm;
	const providerId = settings?.slm?.provider ?? "openai";

	const config = await ModelConfig.load(modelsJsonPath ?? getModelsPath());
	const provider = config.getProvider(providerId);

	// The localhost default belongs to the implicit "openai" setup; an explicitly named
	// provider must resolve somewhere instead of silently hitting the default port.
	const fallbackBaseUrl = settings?.slm?.provider ? undefined : defaults.baseUrl;

	const configuredBaseUrl = settings?.slm?.baseUrl;
	const baseUrl =
		configuredBaseUrl && configuredBaseUrl !== defaults.baseUrl
			? configuredBaseUrl
			: (provider?.baseUrl ?? fallbackBaseUrl);

	const configuredApiKey = settings?.slm?.apiKey;
	const apiKey = unset(configuredApiKey, defaults.apiKey)
		? resolveConfiguredApiKey(provider?.apiKey)
		: resolveConfiguredApiKey(configuredApiKey);

	const configuredModel = settings?.slm?.model;
	const model =
		configuredModel && configuredModel !== defaults.model
			? configuredModel
			: (provider?.models?.[0]?.id ?? defaults.model);

	if (!baseUrl) {
		const catalogNote = config.getError() ? ` (models.json error: ${config.getError()?.split("\n")[0]})` : "";
		throw new Error(
			`No SLM endpoint for provider "${providerId}": set uHarness.slm.baseUrl or register the provider in models.json${catalogNote}`,
		);
	}

	return { baseUrl: baseUrl.replace(/\/+$/, ""), apiKey, model };
}
