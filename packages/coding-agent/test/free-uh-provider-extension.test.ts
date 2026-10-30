import { once } from "node:events";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createEventBus } from "../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.ts";
import freeUhProvider from "../src/extensions/free-uh-provider/index.ts";

const servers: Server[] = [];

async function listen(handler: (request: any, response: ServerResponse) => void): Promise<string> {
	const server = createServer(handler);
	servers.push(server);
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address() as AddressInfo;
	return `http://127.0.0.1:${address.port}/v1`;
}

afterEach(async () => {
	await Promise.all(
		servers.splice(0).map(
			(server) =>
				new Promise<void>((resolve) => {
					server.close(() => resolve());
					server.closeAllConnections();
				}),
		),
	);
});

describe("free-uh-provider extension", () => {
	it("registers a native provider during extension load", async () => {
		const runtime = createExtensionRuntime();
		await loadExtensionFromFactory(
			freeUhProvider,
			process.cwd(),
			createEventBus(),
			runtime,
			"builtin:free-uh-provider",
		);

		const registration = runtime.pendingProviderRegistrations.find((entry) => entry.name === "free-uh-provider");
		expect(registration).toBeDefined();
		expect(registration?.config.name).toBe("Free UH Provider");
		expect(registration?.config.api).toBe("openai-completions");
		expect(registration?.config.authHeader).toBe(true);
		expect(typeof registration?.config.refreshModels).toBe("function");
		expect(typeof registration?.config.oauth?.login).toBe("function");
	});

	it("does not refresh models without network permission", async () => {
		const runtime = createExtensionRuntime();
		await loadExtensionFromFactory(
			freeUhProvider,
			process.cwd(),
			createEventBus(),
			runtime,
			"builtin:free-uh-provider",
		);
		const registration = runtime.pendingProviderRegistrations.find((entry) => entry.name === "free-uh-provider");
		expect(registration?.config.refreshModels).toBeDefined();

		const models = await registration!.config.refreshModels!({
			credential: { type: "api_key", key: "test-key" },
			stored: undefined,
			publish: async () => true,
			allowNetwork: false,
			signal: new AbortController().signal,
			baseUrl: "http://127.0.0.1:1/v1",
		});

		expect(models).toEqual([]);
	});

	it("does not refresh models without an API key", async () => {
		const runtime = createExtensionRuntime();
		await loadExtensionFromFactory(
			freeUhProvider,
			process.cwd(),
			createEventBus(),
			runtime,
			"builtin:free-uh-provider",
		);
		const registration = runtime.pendingProviderRegistrations.find((entry) => entry.name === "free-uh-provider");

		const models = await registration!.config.refreshModels!({
			credential: undefined,
			stored: undefined,
			publish: async () => true,
			allowNetwork: true,
			signal: new AbortController().signal,
			baseUrl: "http://127.0.0.1:1/v1",
		});

		expect(models).toEqual([]);
	});

	it("refreshes and maps models from an OpenAI-compatible /models endpoint", async () => {
		const baseUrl = await listen((_request, response) => {
			response.writeHead(200, { "Content-Type": "application/json" });
			response.end(
				JSON.stringify({
					data: [
						{ id: "free-model-a", reasoning: true, context_window: 64000, max_tokens: 8192 },
						{ id: "free-model-b" },
					],
				}),
			);
		});

		const runtime = createExtensionRuntime();
		await loadExtensionFromFactory(
			freeUhProvider,
			process.cwd(),
			createEventBus(),
			runtime,
			"builtin:free-uh-provider",
		);
		const registration = runtime.pendingProviderRegistrations.find((entry) => entry.name === "free-uh-provider");

		const models = await registration!.config.refreshModels!({
			credential: { type: "api_key", key: "test-key" },
			stored: undefined,
			publish: async () => true,
			allowNetwork: true,
			signal: new AbortController().signal,
			baseUrl,
		});

		expect(models).toEqual([
			expect.objectContaining({
				id: "free-model-a",
				name: "free-model-a",
				provider: "free-uh-provider",
				api: "openai-completions",
				baseUrl,
				reasoning: true,
				input: ["text"],
				contextWindow: 64000,
				maxTokens: 8192,
			}),
			expect.objectContaining({
				id: "free-model-b",
				name: "free-model-b",
				provider: "free-uh-provider",
				api: "openai-completions",
				baseUrl,
				reasoning: false,
				input: ["text"],
				contextWindow: 128000,
				maxTokens: 8192,
			}),
		]);
	});

	it("opens the configured login URL and stores the pasted key", async () => {
		const runtime = createExtensionRuntime();
		await loadExtensionFromFactory(
			freeUhProvider,
			process.cwd(),
			createEventBus(),
			runtime,
			"builtin:free-uh-provider",
		);
		const registration = runtime.pendingProviderRegistrations.find((entry) => entry.name === "free-uh-provider");
		const oauth = registration?.config.oauth;
		expect(oauth).toBeDefined();

		let authUrl = "";
		const credentials = await oauth!.login({
			onAuth: (info) => {
				authUrl = info.url;
			},
			onDeviceCode: () => {},
			onPrompt: async () => "secret-key",
			onProgress: () => {},
			onManualCodeInput: async () => "",
			onSelect: async () => undefined,
			signal: new AbortController().signal,
		});

		expect(authUrl).toBe("https://free-uh-provider.example/login");
		expect(credentials).toMatchObject({ access: "secret-key", refresh: "secret-key" });
		expect(oauth!.getApiKey(credentials)).toBe("secret-key");
	});
});
