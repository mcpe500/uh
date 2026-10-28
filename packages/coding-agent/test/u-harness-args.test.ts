import { describe, expect, it } from "vitest";
import { parseArgs } from "../src/cli/args.ts";

describe("U-Harness CLI Arguments", () => {
	it("parses --pipeline baseline", () => {
		const args = parseArgs(["--pipeline", "baseline"]);
		expect(args.pipeline).toBe("baseline");
		expect(args.diagnostics.length).toBe(0);
	});

	it("parses --pipeline u-shaped", () => {
		const args = parseArgs(["--pipeline", "u-shaped"]);
		expect(args.pipeline).toBe("u-shaped");
		expect(args.diagnostics.length).toBe(0);
	});

	it("records diagnostic error for invalid --pipeline value", () => {
		const args = parseArgs(["--pipeline", "invalid-mode"]);
		expect(args.diagnostics.some((d) => d.message.includes("--pipeline requires"))).toBe(true);
	});

	it("parses --slm-url", () => {
		const args = parseArgs(["--slm-url", "http://localhost:8000/v1"]);
		expect(args.slmUrl).toBe("http://localhost:8000/v1");
		expect(args.diagnostics.length).toBe(0);
	});

	it("records diagnostic error when --slm-url is missing value", () => {
		const args = parseArgs(["--slm-url"]);
		expect(args.diagnostics.some((d) => d.message.includes("--slm-url requires"))).toBe(true);
	});
});
