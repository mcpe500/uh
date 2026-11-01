/**
 * Local web UI for the U-Harness debug log.
 *
 * Started by the u-harness extension when `UH_SLM_DEBUG=1`. Serves a read-only
 * auto-refreshing event table from the JSONL debug log on 127.0.0.1 only;
 * nothing is exposed to other hosts.
 */

import { existsSync, readFileSync, truncateSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export interface DebugUiServer {
	url: string;
	close(): Promise<void>;
}

let runningUrl: string | undefined;

/** URL of the debug UI started in this process, if any. */
export function getRunningDebugUiUrl(): string | undefined {
	return runningUrl;
}

/** Read and parse the debug log, returning at most `limit` newest entries. */
function readEvents(logPath: string, limit: number): Array<Record<string, unknown>> {
	if (!existsSync(logPath)) return [];
	const lines = readFileSync(logPath, "utf8").trim().split("\n");
	const entries: Array<Record<string, unknown>> = [];
	for (const line of lines.slice(-limit)) {
		if (!line) continue;
		try {
			entries.push(JSON.parse(line) as Record<string, unknown>);
		} catch {
			// Skip torn or malformed lines.
		}
	}
	return entries;
}

function sendJson(response: ServerResponse, payload: unknown): void {
	response.writeHead(200, { "Content-Type": "application/json" });
	response.end(JSON.stringify(payload));
}

function handleRequest(logPath: string, request: IncomingMessage, response: ServerResponse): void {
	const url = new URL(request.url ?? "/", "http://127.0.0.1");
	if (url.pathname === "/events") {
		const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 500), 1), 5000);
		const filter = url.searchParams.get("event");
		let entries = readEvents(logPath, limit);
		if (filter) entries = entries.filter((entry) => entry.event === filter);
		sendJson(response, { entries });
		return;
	}
	if (url.pathname === "/clear" && request.method === "POST") {
		if (existsSync(logPath)) truncateSync(logPath, 0);
		sendJson(response, { cleared: true });
		return;
	}
	response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
	response.end(renderPage());
}

function renderPage(): string {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>U-Harness debug</title>
<style>
	body { font-family: ui-monospace, monospace; background: #14161a; color: #d6dadd; margin: 16px; }
	h1 { font-size: 16px; }
	select, button { background: #1f2329; color: inherit; border: 1px solid #3a3f45; padding: 4px 8px; }
	table { border-collapse: collapse; width: 100%; margin-top: 12px; }
	td, th { border: 1px solid #2a2e33; padding: 4px 8px; text-align: left; vertical-align: top; font-size: 12px; }
	th { background: #1f2329; }
	tr.event-error td.event-cell { color: #ff7b72; }
	tr.event-response td.event-cell, tr.event-compress-ok td.event-cell, tr.event-brief-injected td.event-cell { color: #7ee787; }
	tr.event-brief-skipped td.event-cell { color: #d2a8ff; }
	pre { white-space: pre-wrap; word-break: break-all; margin: 0; font-size: 11px; }
	#status { color: #8b949e; font-size: 11px; }
</style>
</head>
<body>
<h1>U-Harness debug log</h1>
<label>event <select id="filter"><option value="">(all)</option></select></label>
<button id="clear">clear log</button>
<span id="status"></span>
<table id="table"><thead><tr><th>time</th><th>event</th><th>detail</th></tr></thead><tbody></tbody></table>
<script>
	const tableBody = document.querySelector("#table tbody");
	const filterSelect = document.querySelector("#filter");
	const status = document.querySelector("#status");
	let knownEvents = new Set();

	function renderDetail(entry) {
		const pre = document.createElement("pre");
		pre.textContent = JSON.stringify(entry, null, 1);
		return pre;
	}

	function render(entries) {
		tableBody.replaceChildren(...entries.map((entry) => {
			const row = document.createElement("tr");
			row.className = "event-" + entry.event;
			const time = document.createElement("td");
			time.textContent = String(entry.ts ?? "");
			const event = document.createElement("td");
			event.className = "event-cell";
			event.textContent = String(entry.event ?? "");
			const detail = document.createElement("td");
			detail.appendChild(renderDetail(entry));
			row.append(time, event, detail);
			return row;
		}));
		entries.forEach((entry) => knownEvents.add(entry.event));
		const selected = filterSelect.value;
		filterSelect.replaceChildren(
			...[...knownEvents].sort().map((name) => {
				const option = document.createElement("option");
				option.value = name;
				option.textContent = name;
				return option;
			}),
		);
		filterSelect.value = selected;
		status.textContent = entries.length + " entries";
	}

	async function refresh() {
		const filter = filterSelect.value;
		const response = await fetch("/events?limit=500" + (filter ? "&event=" + encodeURIComponent(filter) : ""));
		render((await response.json()).entries);
	}

	filterSelect.addEventListener("change", refresh);
	document.querySelector("#clear").addEventListener("click", async () => {
		await fetch("/clear", { method: "POST" });
		refresh();
	});
	refresh();
	setInterval(refresh, 3000);
</script>
</body>
</html>`;
}

/**
 * Start the debug UI server bound to 127.0.0.1.
 * Prefers `preferredPort`; falls back to an ephemeral port when it is taken.
 */
export function startDebugUiServer(logPath: string, preferredPort?: number): Promise<DebugUiServer> {
	return new Promise((resolve, reject) => {
		const server: Server = createServer((request, response) => handleRequest(logPath, request, response));
		const listening = () => {
			const port = (server.address() as { port: number }).port;
			runningUrl = `http://127.0.0.1:${port}`;
			resolve({
				url: runningUrl,
				close: () =>
					new Promise<void>((resolveClose) => {
						server.close(() => {
							if (runningUrl === `http://127.0.0.1:${port}`) runningUrl = undefined;
							resolveClose();
						});
					}),
			});
		};

		let retried = false;
		server.once("error", (error) => {
			if ((error as NodeJS.ErrnoException).code === "EADDRINUSE" && !retried) {
				retried = true;
				server.close(() => server.listen(0, "127.0.0.1", listening));
				return;
			}
			reject(error);
		});
		server.listen(preferredPort ?? 0, "127.0.0.1", listening);
	});
}
