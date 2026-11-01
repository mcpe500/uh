/**
 * Local web UI for the U-Harness debug log.
 *
 * Started by the u-harness extension when `UH_SLM_DEBUG=1`. Serves a read-only,
 * grouped three-stage view (SLM compress / LLM / SLM decompress) of the JSONL
 * debug log on 127.0.0.1 only; nothing is exposed to other hosts. All frontend
 * assets are vendored locally under `/vendor/*` — the page makes no external
 * requests.
 */

import { existsSync, readFileSync, truncateSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { getUHarnessUiVendorDir } from "../../config.ts";

export interface DebugUiServer {
	url: string;
	close(): Promise<void>;
}

let runningUrl: string | undefined;

/** URL of the debug UI started in this process, if any. */
export function getRunningDebugUiUrl(): string | undefined {
	return runningUrl;
}

/** Vendored assets the UI may fetch, keyed by URL path. The allowlist blocks path traversal. */
const vendorAssets: Record<string, { file: string; contentType: string }> = {
	"/vendor/tailwind.js": { file: "tailwind.js", contentType: "text/javascript; charset=utf-8" },
	"/vendor/lucide.min.js": { file: "lucide.min.js", contentType: "text/javascript; charset=utf-8" },
	"/vendor/fonts/InterVariable.woff2": {
		file: join("fonts", "InterVariable.woff2"),
		contentType: "font/woff2",
	},
	"/vendor/fonts/JetBrainsMono.woff2": {
		file: join("fonts", "JetBrainsMono.woff2"),
		contentType: "font/woff2",
	},
};

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

function sendVendorAsset(pathname: string, response: ServerResponse): void {
	const asset = vendorAssets[pathname];
	if (!asset) {
		response.writeHead(404, { "Content-Type": "text/plain" });
		response.end("not found");
		return;
	}
	try {
		const body = readFileSync(join(getUHarnessUiVendorDir(), asset.file));
		response.writeHead(200, { "Content-Type": asset.contentType });
		response.end(body);
	} catch {
		response.writeHead(404, { "Content-Type": "text/plain" });
		response.end("vendor asset missing");
	}
}

function handleRequest(logPath: string, request: IncomingMessage, response: ServerResponse): void {
	// Raw path guard: `..` never reaches routing, so traversal cannot be smuggled
	// through encodings the URL parser might normalize differently.
	if ((request.url ?? "").includes("..")) {
		response.writeHead(404, { "Content-Type": "text/plain" });
		response.end("not found");
		return;
	}
	const url = new URL(request.url ?? "/", "http://127.0.0.1");
	if (url.pathname === "/events") {
		const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 1000), 1), 5000);
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
	if (url.pathname.startsWith("/vendor/")) {
		sendVendorAsset(url.pathname, response);
		return;
	}
	response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
	response.end(renderPage());
}

function renderPage(): string {
	return `<!doctype html>
<html lang="id" class="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>U-Harness debug log</title>
<script src="/vendor/tailwind.js"></script>
<script src="/vendor/lucide.min.js"></script>
<script>
  tailwind.config = {
    darkMode: 'class',
    theme: {
      extend: {
        fontFamily: {
          sans: ['Inter', 'sans-serif'],
          mono: ['JetBrains Mono', 'monospace'],
        },
      },
    },
  };
</script>
<style>
  @font-face {
    font-family: 'Inter';
    src: url('/vendor/fonts/InterVariable.woff2') format('woff2');
    font-weight: 100 900;
    font-display: swap;
  }
  @font-face {
    font-family: 'JetBrains Mono';
    src: url('/vendor/fonts/JetBrainsMono.woff2') format('woff2');
    font-weight: 100 800;
    font-display: swap;
  }
  body { background-color: #070a12; color: #e2e8f0; }
  ::-webkit-scrollbar { width: 7px; height: 7px; }
  ::-webkit-scrollbar-track { background: #0b1120; }
  ::-webkit-scrollbar-thumb { background: #334155; border-radius: 4px; }
  ::-webkit-scrollbar-thumb:hover { background: #475569; }
  tbody.run-group { border-bottom: 3px solid #1e293b; }
  tbody.run-group:hover { background-color: rgba(15, 23, 42, 0.55); }
  .subrow-divider { border-bottom: 1px dashed rgba(51, 65, 85, 0.65); }
</style>
</head>
<body class="min-h-screen font-sans antialiased selection:bg-cyan-500/30 selection:text-cyan-200">

<header class="sticky top-0 z-30 border-b border-slate-800 bg-slate-950/95 backdrop-blur-md">
  <div class="max-w-[1680px] mx-auto px-4 sm:px-6 py-3 flex flex-wrap items-center justify-between gap-4">
    <div class="flex items-center gap-3">
      <div class="w-9 h-9 rounded-lg bg-orange-500/20 border border-orange-500/40 flex items-center justify-center font-mono font-bold text-orange-400">U</div>
      <div>
        <div class="flex items-center gap-2">
          <h1 class="font-mono font-bold text-base sm:text-lg text-white tracking-tight">U-Harness debug log</h1>
          <span class="px-2 py-0.5 text-[11px] font-mono rounded bg-orange-500/15 text-orange-300 border border-orange-500/30">3-Row per Run</span>
        </div>
        <p class="text-xs text-slate-400">
          1 grup baris = 3 request terpisah:
          <span class="text-cyan-400 font-mono font-semibold">[1] SLM compress</span> &rarr;
          <span class="text-purple-400 font-mono font-semibold">[2] LLM</span> &rarr;
          <span class="text-emerald-400 font-mono font-semibold">[3] SLM decompress</span>
        </p>
      </div>
    </div>
    <div class="flex items-center gap-2">
      <button id="clear" class="px-3 py-1.5 rounded-lg text-xs font-mono font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 transition">clear log</button>
      <span id="status" class="text-[11px] font-mono text-slate-500"></span>
    </div>
  </div>
</header>

<main class="max-w-[1680px] mx-auto px-4 sm:px-6 py-5 space-y-4">

  <section class="rounded-xl border border-slate-800 bg-slate-900/80 p-4">
    <div class="grid grid-cols-1 lg:grid-cols-3 gap-3 text-xs">
      <div class="p-3 rounded-lg bg-cyan-950/25 border border-cyan-500/30 space-y-1">
        <div class="flex items-center justify-between font-mono font-bold text-cyan-300">
          <span>ROW 1: SLM compress (Req 1/3)</span>
          <span class="px-1.5 py-0.5 text-[10px] rounded bg-cyan-500/20">SLM</span>
        </div>
        <p class="text-slate-300 leading-relaxed">Prompt berisi <code class="text-amber-300">SPESIFIKASI TUGAS</code> + <code class="text-slate-400">KONTEKS BERKAS</code> + <strong class="text-cyan-300">TUGAS KOMPRESI SLM</strong>. Output: Architectural Brief padat.</p>
      </div>
      <div class="p-3 rounded-lg bg-purple-950/25 border border-purple-500/30 space-y-1">
        <div class="flex items-center justify-between font-mono font-bold text-purple-300">
          <span>ROW 2: LLM (Req 2/3)</span>
          <span class="px-1.5 py-0.5 text-[10px] rounded bg-purple-500/20">main model</span>
        </div>
        <p class="text-slate-300 leading-relaxed">Prompt berisi <code class="text-amber-300">SPESIFIKASI TUGAS</code> + <code class="text-cyan-300">ARCHITECTURAL BRIEF (dari Row 1)</code> + penalaran inti. Output: solusi/blueprint.</p>
      </div>
      <div class="p-3 rounded-lg bg-emerald-950/25 border border-emerald-500/30 space-y-1">
        <div class="flex items-center justify-between font-mono font-bold text-emerald-300">
          <span>ROW 3: SLM decompress (Req 3/3)</span>
          <span class="px-1.5 py-0.5 text-[10px] rounded bg-emerald-500/20">SLM</span>
        </div>
        <p class="text-slate-300 leading-relaxed">Prompt berisi <code class="text-purple-300">BLUEPRINT LLM (dari Row 2)</code> + <code class="text-slate-400">BERKAS TARGET</code> + <strong class="text-emerald-300">TUGAS DEKOMPRESI &amp; PATCH</strong>. Output: patch kode kanonik.</p>
      </div>
    </div>
  </section>

  <section class="flex flex-wrap items-center justify-between gap-3 bg-slate-900/90 border border-slate-800 rounded-xl px-4 py-2.5">
    <div class="flex flex-wrap items-center gap-2 text-xs font-mono">
      <span class="text-slate-400">Filter Stage Row:</span>
      <button data-stage="ALL" class="stage-btn px-2.5 py-1 rounded bg-orange-500 text-slate-950 font-bold transition">All 3 Rows</button>
      <button data-stage="SLM compress" class="stage-btn px-2.5 py-1 rounded bg-cyan-500/15 text-cyan-300 border border-cyan-500/30 hover:bg-cyan-500/25 transition">Row 1: SLM compress</button>
      <button data-stage="LLM" class="stage-btn px-2.5 py-1 rounded bg-purple-500/15 text-purple-300 border border-purple-500/30 hover:bg-purple-500/25 transition">Row 2: LLM</button>
      <button data-stage="SLM decompress" class="stage-btn px-2.5 py-1 rounded bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 hover:bg-emerald-500/25 transition">Row 3: SLM decompress</button>
    </div>
    <div class="flex items-center gap-3">
      <input id="searchBox" type="text" placeholder="Filter prompt / stage / task..."
        class="px-3 py-1.5 bg-slate-950 border border-slate-800 rounded-lg text-xs font-mono text-slate-200 placeholder-slate-500 focus:outline-none focus:border-orange-500 w-64" />
    </div>
  </section>

  <section class="rounded-xl border border-slate-800 bg-slate-950 overflow-hidden shadow-2xl">
    <div class="overflow-x-auto">
      <table class="w-full text-left border-collapse font-mono text-xs">
        <thead>
          <tr class="border-b-2 border-slate-800 bg-slate-900 text-[11px] uppercase tracking-wider text-slate-300">
            <th class="py-3 px-3 w-28 text-center border-r border-slate-800">Run<br><span class="text-[10px] text-orange-400 font-normal">(group)</span></th>
            <th class="py-3 px-2.5 w-16 text-center border-r border-slate-800">Row #</th>
            <th class="py-3 px-3 w-36 border-r border-slate-800">Time &amp; Durasi</th>
            <th class="py-3 px-3 w-44 border-r border-slate-800">Stage<br><span class="text-[10px] text-slate-400 font-normal">(3 request terpisah)</span></th>
            <th class="py-3 px-4 w-[42%] border-r border-slate-800">Prompt Stage Ini<br><span class="text-[10px] text-amber-300 font-normal">(input + instruksi tugas stage)</span></th>
            <th class="py-3 px-4">Response / Output Stage Ini</th>
          </tr>
        </thead>
        <tbody id="emptyRow"><tr><td colspan="6" class="py-8 text-center text-slate-500" id="emptyCell">Belum ada run.</td></tr></tbody>
      </table>
    </div>
  </section>

</main>

<script>
  var stageNames = ["SLM compress", "LLM", "SLM decompress"];
  var currentStage = "ALL";
  var knownRuns = 0;

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function findEntry(entries, runId, event, stage) {
    for (var i = entries.length - 1; i >= 0; i--) {
      var e = entries[i];
      if (e.runId === runId && e.event === event && (stage === undefined || e.stage === stage)) return e;
    }
    return undefined;
  }

  // The initial stage SLM call has no requestIndex; per-request SLM calls (history
  // compression, per-step decompression) carry one. Row 1/Row 3 must show the initial
  // prompt, not the newest per-request SLM call.
  function findInitialEntry(entries, runId, event, stage) {
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      if (e.runId === runId && e.event === event && e.requestIndex === undefined && (stage === undefined || e.stage === stage)) return e;
    }
    return undefined;
  }

  function verdictBadge(verdict) {
    var colors = {
      PASS: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
      FAIL: "bg-rose-500/15 text-rose-300 border-rose-500/30",
      PARTIAL: "bg-amber-500/15 text-amber-300 border-amber-500/30",
      UNKNOWN: "bg-slate-500/15 text-slate-300 border-slate-500/30",
    };
    return el("span", "verdict-badge px-1.5 py-0.5 rounded text-[10px] border font-bold " + (colors[verdict] || colors.UNKNOWN), verdict || "UNKNOWN");
  }

  function buildRequests(entries, runId) {
    var map = {};
    var saved = 0;
    var totalInput = 0;
    entries.forEach(function (e) {
      if (e.runId !== runId || typeof e.requestIndex !== "number") return;
      var r = map[e.requestIndex] || (map[e.requestIndex] = { idx: e.requestIndex, saved: 0, cacheHits: 0 });
      if (e.event === "llm-call-start") {
        r.contextChars = e.contextChars;
        r.ts = e.ts;
        r.messages = e.messages;
      } else if (e.event === "llm-call-end") {
        r.ms = e.ms;
        r.usage = e.usage;
        if (e.usage && typeof e.usage.input === "number") totalInput += e.usage.input;
      } else if (e.event === "history-compressed") {
        r.saved += (e.charsBefore || 0) - (e.charsAfter || 0);
        if (e.cached) r.cacheHits += 1;
        else saved += (e.charsBefore || 0) - (e.charsAfter || 0);
      } else if (e.event === "context-projected") {
        r.projected = e;
      } else if (e.event === "decompress-ok" && e.stage === "SLM decompress") {
        r.verdict = e.verdict;
        r.decompressed = e.outputChars;
      } else if (e.event === "decompress-skip" && e.stage === "SLM decompress") {
        r.decompSkip = e.reason;
      }
    });
    var list = Object.keys(map)
      .map(function (k) { return map[k]; })
      .sort(function (a, b) { return a.idx - b.idx; });
    return { list: list, saved: saved, totalInput: totalInput };
  }

  function buildRequestTriplet(runId, entries) {
    var data = buildRequests(entries, runId);
    var wrap = el("div", "mt-2 space-y-1");
    if (data.list.length === 0) return null;

    var toggle = el(
      "button",
      "toggle-requests px-2 py-0.5 rounded bg-slate-900 border border-slate-700 text-[10px] font-mono text-purple-300 hover:bg-slate-800 transition",
      data.list.length + " request \u25BE  \u2212" + data.saved + " chars \u00B7 \u03A3in " + data.totalInput + " tok",
    );
    var container = el("div", "request-triplet space-y-1");
    toggle.addEventListener("click", function () {
      container.classList.toggle("hidden");
      toggle.textContent = container.classList.contains("hidden")
        ? data.list.length + " request \u25B8  \u2212" + data.saved + " chars \u00B7 \u03A3in " + data.totalInput + " tok"
        : data.list.length + " request \u25BE  \u2212" + data.saved + " chars \u00B7 \u03A3in " + data.totalInput + " tok";
    });
    wrap.append(toggle);

    data.list.forEach(function (r) {
      var line = el("div", "rounded bg-slate-900/80 border border-slate-800 px-2 py-1 flex items-center gap-2 flex-wrap text-[10px] font-mono");
      line.append(
        el("span", "text-purple-300 font-bold", "#" + r.idx),
        el("span", "text-slate-400", r.ts ? r.ts.slice(11, 19) : "-"),
        el("span", "text-slate-300", r.usage && r.usage.input !== undefined ? "in " + r.usage.input + " tok" : (r.contextChars !== undefined ? "ctx " + r.contextChars + " ch" : "-")),
        el("span", "text-slate-400", r.ms !== undefined ? r.ms + " ms" : ""),
        el("span", r.saved > 0 ? "text-cyan-300" : "text-slate-500", r.saved > 0 ? "\u2212" + r.saved + " ch" + (r.cacheHits ? " (" + r.cacheHits + " cache)" : "") : "kompres: \u2014"),
        r.decompressed !== undefined ? el("span", "text-emerald-300", "decomp " + r.decompressed + " ch") : el("span"),
      );
      if (r.decompSkip) line.append(el("span", "text-amber-300", "decomp skip: " + r.decompSkip));
      else line.append(verdictBadge(r.verdict));
      container.append(line);
    });
    wrap.append(container);
    return wrap;
  }

  function buildRow(runId, entries, stageName, stageLabel, requestStage) {
    var skipped = findEntry(entries, runId, "brief-skipped", stageName);
    var request = stageName === "LLM" ? undefined : findInitialEntry(entries, runId, "request", stageName);
    var response = stageName === "LLM" ? undefined : findInitialEntry(entries, runId, "response", stageName);
    var start = stageName === "LLM" ? findEntry(entries, runId, "llm-start") : undefined;
    var end = stageName === "LLM" ? findEntry(entries, runId, "llm-end") : undefined;

    var prompt = start ? start.prompt : (request ? request.prompt : undefined);
    var output = end ? end.output : (response ? response.output : undefined);
    var ms = end ? end.ms : (response ? response.ms : undefined);
    var time = (start && start.ts) || (request && request.ts) || (skipped && skipped.ts) || "";
    var model = request ? request.model : (stageName === "LLM" ? "main model" : "SLM");

    var tr = document.createElement("tr");
    tr.className = "align-top";
    tr.dataset.stage = stageName;

    var rowCell = el("td", "py-3.5 px-2.5 text-center border-r border-slate-800/80");
    var rowWrap = el("div", "flex flex-col items-center gap-1");
    rowWrap.append(
      el("span", "px-1.5 py-0.5 rounded bg-slate-900 border border-slate-700 text-[11px] font-bold text-slate-200", "#" + runId),
      el("span", "text-[10px] text-slate-500", stageLabel),
    );
    rowCell.append(rowWrap);

    var timeCell = el("td", "py-3.5 px-3 border-r border-slate-800/80 space-y-1.5");
    var timeWrap = el("div", "space-y-1.5");
    timeWrap.append(el("div", "text-slate-300 text-[11px]", time ? time.replace("T", " ").replace("Z", "") : "-"));
    var badgeClass = "px-2 py-0.5 rounded text-[10px] border ";
    var badge;
    if (skipped) {
      badge = el("span", badgeClass + "bg-amber-500/15 text-amber-300 border-amber-500/30", "SKIPPED");
    } else if (typeof ms === "number") {
      badge = el("span", badgeClass + "bg-emerald-500/15 text-emerald-300 border-emerald-500/30", "OK (" + ms + " ms)");
    } else {
      badge = el("span", badgeClass + "bg-rose-500/15 text-rose-300 border-rose-500/30", "PENDING");
    }
    timeWrap.append(badge, el("div", "text-[10px] text-slate-500 truncate max-w-[140px]", model || "-"));
    timeCell.append(timeWrap);

    var stageCell = el("td", "py-3.5 px-3 border-r border-slate-800/80");
    var stageColors = {
      "SLM compress": ["bg-cyan-500/20", "text-cyan-300", "border-cyan-500/40", "bg-cyan-400"],
      "LLM": ["bg-purple-500/20", "text-purple-300", "border-purple-500/40", "bg-purple-400"],
      "SLM decompress": ["bg-emerald-500/20", "text-emerald-300", "border-emerald-500/40", "bg-emerald-400"],
    };
    var colors = stageColors[stageName];
    var stageWrap = el("div", "space-y-1");
    var stageBadge = el("span", "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md font-bold text-xs border " + colors[0] + " " + colors[1] + " " + colors[2]);
    stageBadge.append(el("span", "w-2 h-2 rounded-full " + colors[3]), stageName);
    stageWrap.append(stageBadge);
    if (stageName === "LLM") {
      var triplet = buildRequestTriplet(runId, entries);
      if (triplet) stageWrap.append(triplet);
    }
    stageCell.append(stageWrap);

    var promptCell = el("td", "py-3.5 px-4 border-r border-slate-800/80");
    var promptBox = el("div", "rounded-lg bg-slate-900/90 border border-slate-800 p-3");
    var promptPre = el("pre", "whitespace-pre-wrap break-words text-[11px] leading-relaxed text-slate-200",
      prompt !== undefined && prompt !== null && prompt !== "" ? prompt : (skipped ? "(di-skip: " + (skipped.reason || "-") + ")" : "(belum ada)"));
    promptBox.append(promptPre);
    promptCell.append(promptBox);

    var outputCell = el("td", "py-3.5 px-4");
    var outputBox = el("div", "rounded-lg bg-slate-900/50 border border-slate-800/80 p-3");
    var outputColor = stageName === "SLM compress" ? "text-cyan-200" : stageName === "LLM" ? "text-purple-200" : "text-emerald-200";
    var outputPre = el("pre", "whitespace-pre-wrap break-words text-[11px] leading-relaxed " + outputColor,
      output !== undefined && output !== null && output !== "" ? output : (skipped ? "(di-skip)" : "(belum ada)"));
    outputBox.append(outputPre);
    outputCell.append(outputBox);

    tr.append(rowCell, timeCell, stageCell, promptCell, outputCell);
    return tr;
  }

  function buildGroup(runId, entries, stageFilter, query) {
    var agentStart = findEntry(entries, runId, "agent-start");
    var llmStart = findEntry(entries, runId, "llm-start");
    var task = agentStart && agentStart.promptPreview ? agentStart.promptPreview : (llmStart && llmStart.prompt ? llmStart.prompt.split("\\n")[1] : "?");
    var hay = [task].concat(entries.map(function (e) {
      return [e.event, e.stage, e.prompt, e.output, e.reason].join(" ");
    })).join(" ").toLowerCase();
    if (query && hay.indexOf(query) === -1) return null;

    var rows = [
      { stage: "SLM compress", label: "Req 1/3" },
      { stage: "LLM", label: "Req 2/3" },
      { stage: "SLM decompress", label: "Req 3/3" },
    ].filter(function (row) { return stageFilter === "ALL" || row.stage === stageFilter; });
    if (rows.length === 0) return null;

    var tbody = el("tbody", "run-group");
    rows.forEach(function (row, index) {
      var tr = buildRow(runId, entries, row.stage, row.label);
      if (index < rows.length - 1) tr.classList.add("subrow-divider");
      if (index === 0) {
        var groupCell = el("td", "py-4 px-3 text-center border-r border-slate-800 bg-slate-900/70 align-middle");
        groupCell.rowSpan = rows.length;
        var wrap = el("div", "inline-flex flex-col items-center gap-1.5");
        wrap.append(
          el("span", "w-9 h-9 rounded-xl bg-orange-500/20 border-2 border-orange-500/50 text-orange-300 font-bold text-sm flex items-center justify-center shadow", String(runId)),
          el("div", "mt-1 max-w-[110px] text-[10px] text-amber-300 font-semibold break-words leading-tight", '"' + task + '"'),
        );
        groupCell.append(wrap);
        tr.insertBefore(groupCell, tr.firstChild);
      }
      tbody.append(tr);
    });
    return tbody;
  }

  function render(entries) {
    var table = document.querySelector("table");
    table.querySelectorAll("tbody.run-group").forEach(function (node) { node.remove(); });

    var query = (document.getElementById("searchBox").value || "").trim().toLowerCase();
    var byRun = new Map();
    var orphanCount = 0;
    entries.forEach(function (e) {
      if (typeof e.runId !== "number") { orphanCount++; return; }
      if (!byRun.has(e.runId)) byRun.set(e.runId, []);
      byRun.get(e.runId).push(e);
    });

    var runIds = Array.from(byRun.keys()).sort(function (a, b) { return a - b; });
    knownRuns = runIds.length;
    runIds.forEach(function (runId) {
      var tbody = buildGroup(runId, byRun.get(runId), currentStage, query);
      if (tbody) table.append(tbody);
    });

    var empty = document.getElementById("emptyRow");
    var emptyCell = document.getElementById("emptyCell");
    if (knownRuns === 0) {
      empty.classList.remove("hidden");
      emptyCell.textContent = orphanCount > 0
        ? "Belum ada run dengan runId (" + orphanCount + " entry lama di-skip; pakai clear log)."
        : "Belum ada run.";
    } else {
      empty.classList.add("hidden");
    }
    document.getElementById("status").textContent = knownRuns + " runs / " + entries.length + " entries";
  }

  function refresh() {
    fetch("/events?limit=1000")
      .then(function (response) { return response.json(); })
      .then(function (data) { render(data.entries || []); })
      .catch(function () {});
  }

  document.querySelectorAll(".stage-btn").forEach(function (button) {
    button.addEventListener("click", function () {
      currentStage = button.dataset.stage;
      document.querySelectorAll(".stage-btn").forEach(function (other) {
        other.classList.toggle("ring-2", other === button);
        other.classList.toggle("ring-orange-400", other === button);
      });
      refresh();
    });
  });
  document.getElementById("searchBox").addEventListener("input", refresh);
  document.getElementById("clear").addEventListener("click", function () {
    fetch("/clear", { method: "POST" }).then(refresh);
  });
  refresh();
  setInterval(refresh, 3000);
  if (window.lucide && lucide.createIcons) lucide.createIcons();
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
