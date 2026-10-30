import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { UHarnessBridge } from "../src/core/u-harness/bridge.ts";
import { JanasServer } from "../src/core/u-harness/janas.ts";
import { parseSlmSetArgs } from "../src/extensions/slm/slm-config.ts";

const servers: Array<{ stop: () => Promise<void> }> = [];

afterEach(async () => {
	await Promise.all(servers.map((server) => server.stop()));
	servers.length = 0;
});

describe("Janas local SLM", () => {
	it("parses provider-aware /slm-set arguments", () => {
		expect(parseSlmSetArgs("qwen3.5-2b")).toEqual({ model: "qwen3.5-2b" });
		expect(parseSlmSetArgs("janas qwen3.5-2b")).toEqual({ provider: "janas", model: "qwen3.5-2b" });
		expect(parseSlmSetArgs("janas qwen3.5-2b --executable /usr/local/bin/janas-server")).toEqual({
			provider: "janas",
			model: "qwen3.5-2b",
			executablePath: "/usr/local/bin/janas-server",
		});
	});

	it("lets the caller provide the SLM call", async () => {
		const bridge = new UHarnessBridge({ pipeline: "u-shaped" });
		const brief = await bridge.compressInbound("Add demo", [], async () => {
			return "=== ARCHITECTURAL BRIEF ===\nTarget function: demo() in demo.ts.\n=== END BRIEF ===";
		});

		expect(brief).toContain("Target function: demo()");
	});

	it("starts and stops an external OpenAI-compatible Janas process", async () => {
		const directory = mkdtempSync(join(tmpdir(), "janas-server-"));
		const serverScript = join(directory, "janas-server.js");
		writeFileSync(
			serverScript,
			`const http = require("node:http");
const model = process.argv[2];
const portIndex = process.argv.indexOf("--port");
const port = Number(process.argv[portIndex + 1]);
const server = http.createServer((request, response) => {
	if (request.url === "/health") {
		response.writeHead(200).end("ok");
		return;
	}
	if (request.url === "/v1/chat/completions") {
		let body = "";
		request.on("data", (chunk) => { body += chunk; });
		request.on("end", () => {
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify({
				choices: [{ message: { content: "=== ARCHITECTURAL BRIEF ===\\nTarget function: demo() in demo.ts.\\n=== END BRIEF ===" } }],
			}));
		});
		return;
	}
	response.writeHead(404).end();
});
server.listen(port, "127.0.0.1");
process.on("SIGTERM", () => server.close(() => process.exit(0)));
`,
		);

		const server = new JanasServer(
			{
				slm: {
					provider: "janas",
					model: serverScript,
					executablePath: process.execPath,
					apiKey: "none",
				},
			},
			{ startupTimeoutMs: 5000, pollIntervalMs: 25 },
		);
		servers.push(server);

		const baseUrl = await server.start();
		expect(server.running).toBe(true);
		expect(baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/u);

		const response = await fetch(`${baseUrl}/chat/completions`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: "qwen3.5-2b",
				messages: [{ role: "user", content: "Add demo" }],
			}),
		});
		expect(response.ok).toBe(true);
		const payload = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
		expect(payload.choices?.[0]?.message?.content).toContain("Target function: demo()");

		await server.stop();
		expect(server.running).toBe(false);
	});
});
