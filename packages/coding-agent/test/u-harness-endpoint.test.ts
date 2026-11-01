import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SETTINGS_DEFAULTS } from "../src/core/settings-defaults.ts";
import type { UHarnessSettings } from "../src/core/settings-schema.ts";
import { resolveSlmEndpoint } from "../src/core/u-harness/endpoint.ts";

const defaults = SETTINGS_DEFAULTS.uHarness.slm;
const directories: string[] = [];

function writeModelsJson(providers: unknown): string {
	const directory = mkdtempSync(join(tmpdir(), "uh-endpoint-"));
	directories.push(directory);
	const modelsJsonPath = join(directory, "models.json");
	writeFileSync(modelsJsonPath, JSON.stringify(providers));
	return modelsJsonPath;
}

afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("u-harness SLM endpoint resolution", () => {
	it("prefers explicit settings over the models.json provider", async () => {
		const modelsJsonPath = writeModelsJson({
			providers: {
				"9router-local": { baseUrl: "http://catalog:1/v1", apiKey: "sk-catalog", models: [{ id: "opendata" }] },
			},
		});
		const settings = {
			slm: { provider: "9router-local", baseUrl: "http://127.0.0.1:9999/v1", model: "m1", apiKey: "sk-explicit" },
		} as UHarnessSettings;

		expect(await resolveSlmEndpoint(settings, modelsJsonPath)).toEqual({
			baseUrl: "http://127.0.0.1:9999/v1",
			apiKey: "sk-explicit",
			model: "m1",
		});
	});

	it("falls back to the models.json provider for unset settings", async () => {
		const modelsJsonPath = writeModelsJson({
			providers: {
				"9router-local": {
					baseUrl: "http://localhost:20128/v1/",
					apiKey: "$UH_ENDPOINT_TEST_KEY",
					models: [{ id: "opendata" }, { id: "9router-local-combo-2" }],
				},
			},
		});
		const settings = { slm: { provider: "9router-local" } } as UHarnessSettings;
		process.env.UH_ENDPOINT_TEST_KEY = "sk-env";

		try {
			expect(await resolveSlmEndpoint(settings, modelsJsonPath)).toEqual({
				baseUrl: "http://localhost:20128/v1",
				apiKey: "sk-env",
				model: "opendata",
			});
		} finally {
			delete process.env.UH_ENDPOINT_TEST_KEY;
		}
	});

	it("treats the default apiKey as unset", async () => {
		const modelsJsonPath = writeModelsJson({ providers: {} });
		const settings = {
			slm: { provider: "openai", baseUrl: "http://127.0.0.1:9999/v1", apiKey: defaults.apiKey },
		} as UHarnessSettings;

		const endpoint = await resolveSlmEndpoint(settings, modelsJsonPath);
		expect(endpoint.apiKey).toBeUndefined();
	});

	it("throws naming the provider when no endpoint exists", async () => {
		const modelsJsonPath = writeModelsJson({ providers: {} });
		const settings = { slm: { provider: "missing-provider" } } as UHarnessSettings;

		await expect(resolveSlmEndpoint(settings, modelsJsonPath)).rejects.toThrow(
			'No SLM endpoint for provider "missing-provider"',
		);
	});
});
