/**
 * Built-in extension that registers the U-Harness "free-uh-provider" provider.
 *
 * The provider is intentionally implemented as an extension so the fork can keep
 * syncing with upstream Pi without touching the core provider catalog. Endpoint
 * details are placeholder-driven and can be overridden with environment variables.
 */
import type { ExtensionAPI } from "../../core/extensions/types.ts";

const LOGIN_URL = process.env.FREE_UH_LOGIN_URL ?? "https://free-uh-provider.example/login";
const BASE_URL = process.env.FREE_UH_BASE_URL ?? "https://free-uh-provider.example/v1";
const API_KEY_ENV = "FREE_UH_API_KEY";

export default function freeUhProvider(pi: ExtensionAPI): void {
	pi.registerProvider("free-uh-provider", {
		name: "Free UH Provider",
		baseUrl: BASE_URL,
		apiKey: `$${API_KEY_ENV}`,
		api: "openai-completions",
		authHeader: true,
		oauth: {
			name: "Free UH Provider (Web Login)",
			async login(callbacks) {
				callbacks.onAuth({
					url: LOGIN_URL,
					instructions: "Login or register in the browser, then paste the API key.",
				});
				const key = await callbacks.onPrompt({
					message: "Paste Free UH API key:",
					allowEmpty: false,
				});
				if (!key.trim()) throw new Error("Free UH API key is required");
				return {
					refresh: key,
					access: key,
					expires: Date.now() + 365 * 24 * 60 * 60 * 1000,
				};
			},
			async refreshToken(credentials) {
				return credentials;
			},
			getApiKey(credentials) {
				return credentials.access;
			},
		},
		refreshModels: async (context) => {
			const baseUrl = context.baseUrl ?? BASE_URL;
			const credential = context.credential;
			const key =
				credential && "access" in credential && typeof credential.access === "string"
					? credential.access
					: credential && "key" in credential && typeof credential.key === "string"
						? credential.key
						: process.env[API_KEY_ENV];
			if (!context.allowNetwork || !key) return [];
			const response = await fetch(`${baseUrl.replace(/\/$/, "")}/models`, {
				headers: { Authorization: `Bearer ${key}` },
				signal: context.signal,
			});
			if (!response.ok) throw new Error(`Free UH model refresh failed: ${response.status}`);
			const data = (await response.json()) as unknown;
			const items = Array.isArray(data)
				? data
				: typeof data === "object" && data !== null && Array.isArray((data as { data?: unknown }).data)
					? (data as { data: unknown[] }).data
					: [];
			return items
				.filter(
					(item): item is Record<string, unknown> => typeof item === "object" && item !== null && "id" in item,
				)
				.map((item) => ({
					id: String(item.id),
					name: String(item.id),
					api: "openai-completions" as const,
					provider: "free-uh-provider",
					baseUrl,
					reasoning: Boolean(item.reasoning),
					input: ["text"] as Array<"text" | "image">,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: Number(item.context_window ?? 128000),
					maxTokens: Number(item.max_tokens ?? 8192),
				}));
		},
	});
}
