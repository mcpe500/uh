import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createEventBus } from "../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.ts";
import slmExtension from "../src/extensions/slm/index.ts";
import { getSlmProviderInfo, listSlmModels, setSlmSettings } from "../src/extensions/slm/slm-config.ts";

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

describe("slm extension", () => {
	it("registers the /slm commands", async () => {
		const runtime = createExtensionRuntime();
		const extension = await loadExtensionFromFactory(
			slmExtension,
			process.cwd(),
			createEventBus(),
			runtime,
			"builtin:slm",
		);

		expect(extension.commands.get("slm-providers")).toBeDefined();
		expect(extension.commands.get("slm-models")).toBeDefined();
		expect(extension.commands.get("slm-set")).toBeDefined();
	});

	it("falls back to the default SLM settings", () => {
		expect(getSlmProviderInfo(undefined)).toEqual({
			provider: "openai",
			baseUrl: "http://localhost:8000/v1",
			model: "Qwen/Qwen2.5-Coder-1.5B-Instruct",
		});
	});

	it("lists models from the configured endpoint", async () => {
		const baseUrl = await listen((_request, response) => {
			response.writeHead(200, { "Content-Type": "application/json" });
			response.end(JSON.stringify({ data: [{ id: "slm-a" }, { id: "slm-b" }] }));
		});

		const models = await listSlmModels({ slm: { baseUrl } });
		expect(models).toEqual(["slm-a", "slm-b"]);
	});

	it("writes SLM settings without discarding other settings", () => {
		const directory = mkdtempSync(join(tmpdir(), "slm-settings-"));
		const settingsPath = join(directory, "settings.json");
		try {
			setSlmSettings(settingsPath, { model: "slm-new" });

			const parsed = JSON.parse(readFileSync(settingsPath, "utf8"));
			expect(parsed.uHarness.slm.model).toBe("slm-new");
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
