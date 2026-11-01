import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type DebugUiServer, startDebugUiServer } from "../src/core/u-harness/debug-server.ts";

const directories: string[] = [];
const servers: DebugUiServer[] = [];

function writeLog(entries: Array<Record<string, unknown>>): string {
	const directory = mkdtempSync(join(tmpdir(), "uh-debug-ui-"));
	directories.push(directory);
	const logPath = join(directory, "uh-slm-debug.log");
	writeFileSync(logPath, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
	return logPath;
}

afterEach(async () => {
	for (const server of servers.splice(0)) await server.close();
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("u-harness debug UI server", () => {
	it("serves parsed log entries on /events and filters by event", async () => {
		const logPath = writeLog([
			{ ts: "t1", event: "request", attempt: 1 },
			{ ts: "t2", event: "response", ms: 12 },
			{ ts: "t3", event: "brief-injected", briefChars: 10 },
		]);
		const ui = await startDebugUiServer(logPath, 0);
		servers.push(ui);

		const all = await (await fetch(`${ui.url}/events`)).json();
		expect(all.entries).toHaveLength(3);
		expect(all.entries[0].event).toBe("request");

		const filtered = await (await fetch(`${ui.url}/events?event=brief-injected`)).json();
		expect(filtered.entries).toHaveLength(1);
		expect(filtered.entries[0].briefChars).toBe(10);
	});

	it("serves the UI page and clears the log on POST /clear", async () => {
		const logPath = writeLog([{ ts: "t1", event: "request" }]);
		const ui = await startDebugUiServer(logPath, 0);
		servers.push(ui);

		const page = await (await fetch(`${ui.url}/`)).text();
		expect(page).toContain("U-Harness debug log");

		const clear = await (await fetch(`${ui.url}/clear`, { method: "POST" })).json();
		expect(clear.cleared).toBe(true);
		const after = await (await fetch(`${ui.url}/events`)).json();
		expect(after.entries).toHaveLength(0);
		expect(readFileSync(logPath, "utf8")).toBe("");
	});

	it("skips malformed lines and still serves the valid ones", async () => {
		const directory = mkdtempSync(join(tmpdir(), "uh-debug-ui-"));
		directories.push(directory);
		const logPath = join(directory, "uh-slm-debug.log");
		writeFileSync(logPath, '{"event":"request"}\n{torn json\n');

		const ui = await startDebugUiServer(logPath, 0);
		servers.push(ui);

		const all = await (await fetch(`${ui.url}/events`)).json();
		expect(all.entries).toHaveLength(1);
		expect(all.entries[0].event).toBe("request");
	});
});
