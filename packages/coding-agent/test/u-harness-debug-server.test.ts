import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { get } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type DebugUiServer, startDebugUiServer } from "../src/core/u-harness/debug-server.ts";

const directories: string[] = [];
const servers: DebugUiServer[] = [];

/** GET with a raw, unnormalized request path (fetch would normalize `..` away client-side). */
function rawGet(url: string, path: string): Promise<{ status: number | undefined }> {
	return new Promise((resolve, reject) => {
		const { hostname, port } = new URL(url);
		const request = get({ hostname, port, path }, (response) => {
			response.resume();
			resolve({ status: response.statusCode });
		});
		request.on("error", reject);
	});
}

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
		expect(page).toContain("run-group");
		expect(page).toContain("SLM compress");
		expect(page).toContain("SLM decompress");
		expect(page).toContain("/vendor/tailwind.js");
		expect(page).toContain("/vendor/lucide.min.js");
		expect(page).toContain("/vendor/fonts/InterVariable.woff2");
		expect(page).not.toContain("cdn.tailwindcss.com");
		expect(page).not.toContain("unpkg.com");

		const clear = await (await fetch(`${ui.url}/clear`, { method: "POST" })).json();
		expect(clear.cleared).toBe(true);
		const after = await (await fetch(`${ui.url}/events`)).json();
		expect(after.entries).toHaveLength(0);
		expect(readFileSync(logPath, "utf8")).toBe("");
	});

	it("serves vendored UI assets locally with correct content types", async () => {
		const logPath = writeLog([{ ts: "t1", event: "request" }]);
		const ui = await startDebugUiServer(logPath, 0);
		servers.push(ui);

		const tailwind = await fetch(`${ui.url}/vendor/tailwind.js`);
		expect(tailwind.status).toBe(200);
		expect(tailwind.headers.get("content-type")).toContain("text/javascript");
		expect(await tailwind.text()).toContain("tailwind");

		const lucide = await fetch(`${ui.url}/vendor/lucide.min.js`);
		expect(lucide.status).toBe(200);
		expect(await lucide.text()).toContain("createIcons");

		const font = await fetch(`${ui.url}/vendor/fonts/InterVariable.woff2`);
		expect(font.status).toBe(200);
		expect(font.headers.get("content-type")).toContain("font/woff2");
		const bytes = new Uint8Array(await font.arrayBuffer());
		expect([bytes[0], bytes[1], bytes[2], bytes[3]]).toEqual([0x77, 0x4f, 0x46, 0x32]);

		const missing = await rawGet(ui.url, "/vendor/../secret.txt");
		expect(missing.status).toBe(404);
		const unknown = await fetch(`${ui.url}/vendor/nope.js`);
		expect(unknown.status).toBe(404);
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
