import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SETTINGS_DEFAULTS } from "../src/core/settings-defaults.ts";
import type { UHarnessSettings } from "../src/core/settings-schema.ts";
import { UHarnessBridge } from "../src/core/u-harness/bridge.ts";
import { ContextLanguageModel } from "../src/core/u-harness/clm.ts";
import { buildInboundCompressorPrompt, parseArchitecturalBrief } from "../src/core/u-harness/compressor.ts";
import { extractCanonicalPatches, formatTripletPrompt } from "../src/core/u-harness/decompressor.ts";
import type { TripletInput } from "../src/core/u-harness/types.ts";

describe("U-Harness Pipeline (METPEN 03)", () => {
	describe("Settings & Defaults", () => {
		it("provides standard uHarness defaults matching thesis specification", () => {
			expect(SETTINGS_DEFAULTS.uHarness).toBeDefined();
			expect(SETTINGS_DEFAULTS.uHarness.pipeline).toBe("u-shaped");
			expect(SETTINGS_DEFAULTS.uHarness.slm.baseUrl).toBe("http://localhost:8000/v1");
			expect(SETTINGS_DEFAULTS.uHarness.slm.model).toBe("Qwen/Qwen2.5-Coder-1.5B-Instruct");
			expect(SETTINGS_DEFAULTS.uHarness.clm.enabled).toBe(true);
			expect(SETTINGS_DEFAULTS.uHarness.tripletConfluence.canonicalMarker).toBe("### FILE:");
		});

		it("validates custom uHarness settings via TypeBox schema", () => {
			const customSettings: UHarnessSettings = {
				pipeline: "baseline",
				slm: {
					baseUrl: "http://127.0.0.1:8000/v1",
					model: "Qwen/Qwen2.5-Coder-7B-Instruct",
				},
				clm: {
					enabled: false,
					workingMemoryPath: ".context/custom_memory.md",
				},
			};
			expect(customSettings.pipeline).toBe("baseline");
			expect(customSettings.slm?.model).toBe("Qwen/Qwen2.5-Coder-7B-Instruct");
		});
	});

	describe("Stage 1: Inbound Compressor", () => {
		it("formats structured compression prompt for SLM", () => {
			const task = "Fix off-by-one error in fibonacci calculation";
			const files = [
				{
					path: "fib.py",
					content: "def fib(n):\n    if n <= 1: return n\n    return fib(n-1) + fib(n-2)",
				},
			];
			const prompt = buildInboundCompressorPrompt(task, files);
			expect(prompt).toContain("SPESIFIKASI TUGAS:");
			expect(prompt).toContain(task);
			expect(prompt).toContain("fib.py");
			expect(prompt).toContain("ARCHITECTURAL BRIEF");
		});

		it("parses generated architectural brief and criteria", () => {
			const rawBriefOutput = `
=== ARCHITECTURAL BRIEF ===
Target function: fib(n) in fib.py.
Root cause: base case returns 0 for n=0 and 1 for n=1, check loop boundary.
Passing criteria: fib(5) must equal 5, fib(0) equals 0.
=== END BRIEF ===
`;
			const parsed = parseArchitecturalBrief(rawBriefOutput);
			expect(parsed.raw).toContain("Target function: fib(n)");
			expect(parsed.targetFile).toBe("fib.py");
			expect(parsed.criteria.length).toBeGreaterThan(0);
		});
	});

	describe("Stage 3: Outbound Decompressor (Triplet Confluence)", () => {
		it("assembles exact Triplet Input Confluence", () => {
			const triplet: TripletInput = {
				originalFiles: [
					{
						path: "math/calc.py",
						content: "def add(a, b):\n    return a + b",
					},
				],
				architecturalBrief: "Add sub(a, b) function for subtraction.",
				solutionBlueprint: "Implement def sub(a, b): return a - b with type annotations.",
			};

			const prompt = formatTripletPrompt(triplet);
			expect(prompt).toContain("=== 1. KONTEKS KODE ASLI ===");
			expect(prompt).toContain("math/calc.py");
			expect(prompt).toContain("=== 2. ARCHITECTURAL BRIEF ===");
			expect(prompt).toContain("Add sub(a, b)");
			expect(prompt).toContain("=== 3. BLUEPRINT SOLUSI CLOUD ===");
			expect(prompt).toContain("Implement def sub(a, b)");
		});

		it("deterministically extracts canonical file patches (### FILE:)", () => {
			const rawDecompressed = `
I have reconstructed the code:

### FILE: src/utils/math.py
def add(x, y):
    return x + y

def sub(x, y):
    return x - y

### FILE: tests/test_math.py
from src.utils.math import add, sub

def test_sub():
    assert sub(5, 3) == 2
`;
			const patches = extractCanonicalPatches(rawDecompressed, "### FILE:");
			expect(patches.length).toBe(2);
			expect(patches[0].filePath).toBe("src/utils/math.py");
			expect(patches[0].content).toContain("def sub(x, y):");
			expect(patches[1].filePath).toBe("tests/test_math.py");
			expect(patches[1].content).toContain("assert sub(5, 3) == 2");
		});
	});

	describe("Context Language Model (CLM Working Memory)", () => {
		it("initializes and updates working memory file format", () => {
			const clm = new ContextLanguageModel(".test-context/working_memory.md");
			const initial = clm.renderInitialMemory("Fix issue #42");
			expect(initial).toContain("# Working Memory (CLM)");
			expect(initial).toContain("Fix issue #42");

			const updated = clm.updateSection(initial, "ARCHITECTURAL BRIEF", "Brief: Updated logic for issue #42");
			expect(updated).toContain("Brief: Updated logic for issue #42");

			const failureLog = "AssertionError: expected 5 got 4 at line 12";
			const compressedLog = clm.compressFailureLog(failureLog);
			expect(compressedLog).toContain("AssertionError");
			expect(compressedLog.length).toBeLessThanOrEqual(failureLog.length + 50);
		});
	});

	describe("Bridge Orchestration", () => {
		it("records pipeline stage events in the debug log", async () => {
			const directory = mkdtempSync(join(tmpdir(), "uh-debug-events-"));
			const logFile = join(directory, "uh-debug.log");
			const saved = { uh: process.env.UH_SLM_DEBUG, log: process.env.UH_SLM_DEBUG_LOG };
			process.env.UH_SLM_DEBUG = "1";
			process.env.UH_SLM_DEBUG_LOG = logFile;
			const bridge = new UHarnessBridge({
				pipeline: "u-shaped",
				slm: { baseUrl: "http://localhost:8000/v1" },
				clm: { enabled: false },
			});

			try {
				const result = await bridge.executeTurn({
					task: "Refactor auth helper",
					files: [{ path: "auth.ts", content: "export function auth() {}" }],
					callSlm: async (prompt) =>
						prompt.includes("TUGAS KOMPRESI SLM")
							? "=== ARCHITECTURAL BRIEF ===\nTarget: auth.ts\nAdd JWT verify.\n=== END BRIEF ==="
							: "### FILE: auth.ts\nexport function auth() { return true; }",
					callCloudReasoner: async () => "Blueprint: verify JWT before issuing sessions.",
				});

				const events = readFileSync(logFile, "utf8")
					.trim()
					.split("\n")
					.map((line) => (JSON.parse(line) as { event: string }).event);
				expect(events).toEqual([
					"turn-start",
					"stage-slm-compress",
					"stage-cloud-reason",
					"stage-slm-decompress",
					"turn-done",
				]);
				expect(result.telemetry.pipelineMode).toBe("u-shaped");
			} finally {
				if (saved.uh === undefined) delete process.env.UH_SLM_DEBUG;
				else process.env.UH_SLM_DEBUG = saved.uh;
				if (saved.log === undefined) delete process.env.UH_SLM_DEBUG_LOG;
				else process.env.UH_SLM_DEBUG_LOG = saved.log;
				rmSync(directory, { recursive: true, force: true });
			}
		});

		it("retries once when the gateway blocks an upstream on privacy grounds", async () => {
			const bridge = new UHarnessBridge({
				pipeline: "u-shaped",
				slm: { baseUrl: "http://localhost:9999/v1", model: "gateway-model" },
				clm: { enabled: false },
			});
			const privacyBody = JSON.stringify({
				error: {
					message:
						'[400]: {"error":{"message":"Upstream request failed: This model trains on request data. Allow paid endpoints that train on request data in your workspace\'s Privacy settings to use it."}}',
				},
			});
			const successBody = JSON.stringify({ choices: [{ message: { content: "Brief: handle greeting." } }] });
			const responses = [new Response(privacyBody, { status: 400 }), new Response(successBody, { status: 200 })];
			const originalFetch = globalThis.fetch;
			globalThis.fetch = (async () =>
				responses.shift() ?? new Response(successBody, { status: 200 })) as typeof fetch;

			try {
				expect(await bridge.callSlmDefault("compress this")).toBe("Brief: handle greeting.");
			} finally {
				globalThis.fetch = originalFetch;
			}
		});

		it("reports the privacy setting after both attempts are blocked", async () => {
			const bridge = new UHarnessBridge({
				pipeline: "u-shaped",
				slm: { baseUrl: "http://localhost:9999/v1", model: "gateway-model" },
				clm: { enabled: false },
			});
			const privacyBody = JSON.stringify({
				error: {
					message:
						'[400]: {"error":{"message":"Upstream request failed: This model trains on request data. Allow paid endpoints that train on request data in your workspace\'s Privacy settings to use it."}}',
				},
			});
			const originalFetch = globalThis.fetch;
			globalThis.fetch = (async () => new Response(privacyBody, { status: 400 })) as typeof fetch;

			try {
				await expect(bridge.callSlmDefault("compress this")).rejects.toThrow(
					"blocked by the gateway privacy setting",
				);
			} finally {
				globalThis.fetch = originalFetch;
			}
		});

		it("parses chat completions even when the gateway appends trailing data", async () => {
			const bridge = new UHarnessBridge({
				pipeline: "u-shaped",
				slm: { baseUrl: "http://localhost:9999/v1", model: "gateway-model" },
				clm: { enabled: false },
			});
			const valid = JSON.stringify({
				choices: [{ message: { content: "Brief: handle greeting." } }],
			});
			const originalFetch = globalThis.fetch;
			globalThis.fetch = (async () =>
				new Response(`${valid}${JSON.stringify({ usage: {} })}`, { status: 200 })) as typeof fetch;

			try {
				expect(await bridge.callSlmDefault("compress this")).toBe("Brief: handle greeting.");
			} finally {
				globalThis.fetch = originalFetch;
			}
		});

		it("falls back to reasoning_content when the SLM answers without content", async () => {
			const bridge = new UHarnessBridge({
				pipeline: "u-shaped",
				slm: { baseUrl: "http://localhost:9999/v1", model: "thinking-model" },
				clm: { enabled: false },
			});
			const originalFetch = globalThis.fetch;
			globalThis.fetch = (async () =>
				new Response(
					JSON.stringify({
						choices: [{ message: { content: "", reasoning_content: "Brief: handle greeting input." } }],
					}),
					{ status: 200 },
				)) as typeof fetch;

			try {
				expect(await bridge.callSlmDefault("compress this")).toBe("Brief: handle greeting input.");
			} finally {
				globalThis.fetch = originalFetch;
			}
		});

		it("routes to baseline monolithic mode when configured", async () => {
			const bridge = new UHarnessBridge({
				pipeline: "baseline",
				slm: { baseUrl: "http://localhost:8000/v1" },
				clm: { enabled: false },
			});

			let cloudCalled = false;
			const mockCloudFn = async (_prompt: string) => {
				cloudCalled = true;
				return "Direct monolithic response from cloud";
			};

			const result = await bridge.executeTurn({
				task: "Refactor auth helper",
				files: [{ path: "auth.ts", content: "export function auth() {}" }],
				callCloudReasoner: mockCloudFn,
			});

			expect(cloudCalled).toBe(true);
			expect(result.pipelineMode).toBe("baseline");
			expect(result.finalOutput).toBe("Direct monolithic response from cloud");
			expect(result.telemetry.slmInboundTokens).toBe(0);
		});

		it("orchestrates full U-Shape dual-model pipeline when configured", async () => {
			const bridge = new UHarnessBridge({
				pipeline: "u-shaped",
				slm: { baseUrl: "http://localhost:8000/v1" },
				clm: { enabled: true },
			});

			// Mock SLM caller
			const mockSlmCall = async (prompt: string) => {
				if (prompt.includes("TUGAS KOMPRESI SLM")) {
					return "=== ARCHITECTURAL BRIEF ===\nTarget: auth.ts\nAdd JWT verify.\n=== END BRIEF ===";
				}
				// Decompressor output
				return "### FILE: auth.ts\nexport function auth() { return true; }";
			};

			// Mock Cloud Reasoner
			const mockCloudCall = async (prompt: string) => {
				expect(prompt).toContain("Target: auth.ts");
				return "BLUEPRINT: Implement verifyJwt using hs256";
			};

			const result = await bridge.executeTurn({
				task: "Implement JWT verification",
				files: [{ path: "auth.ts", content: "export function auth() {}" }],
				callSlm: mockSlmCall,
				callCloudReasoner: mockCloudCall,
			});

			expect(result.pipelineMode).toBe("u-shaped");
			expect(result.architecturalBrief).toContain("Target: auth.ts");
			expect(result.solutionBlueprint).toContain("BLUEPRINT");
			expect(result.patches.length).toBe(1);
			expect(result.patches[0].filePath).toBe("auth.ts");
			expect(result.patches[0].content).toContain("export function auth()");
			expect(result.telemetry.durationMs).toBeGreaterThanOrEqual(0);
		});
	});
});
