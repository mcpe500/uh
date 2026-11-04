import type { ArchitecturalBrief, RepoFile } from "./types.ts";

/**
 * Builds the structured input prompt for the SLM Inbound Compressor.
 * Takes repository files and user task and requests a compact architectural brief (~80 tokens).
 */
export function buildInboundCompressorPrompt(task: string, files: RepoFile[]): string {
	const fileSections = files.map((f) => `--- FILE: ${f.path} ---\n${f.content}\n--- END FILE ---`).join("\n\n");

	return `SPESIFIKASI TUGAS:
${task}

KONTEKS BERKAS REPOSITORI:
${fileSections}

TUGAS KOMPRESI SLM:
Analisis tugas dan kode repositori di atas.
Eliminasi boilerplate dan dependensi pasif.
Hasilkan output padat strictly dengan format berikut:

=== ARCHITECTURAL BRIEF ===
Target function / component: [nama komponen/fungsi dan berkas target]
Root cause / problem: [ringkasan masalah 1-2 kalimat]
Passing criteria: [poin-poin kriteria lulus pengujian]
=== END BRIEF ===`;
}

/**
 * Builds the prompt for compressing one old tool result during the per-request
 * history projection. Output is a plain dense summary (no structured markers).
 */
export function buildHistoryCompressPrompt(toolName: string, text: string): string {
	return `TUGAS RINGKAS HISTORY SLM:
Ringkas hasil tool berikut menjadi poin-poin padat (maksimal ~300 kata).
Pertahankan: path berkas, nama simbol/fungsi, angka, error, dan keputusan penting.
Buang: boilerplate, log berulang, dan isi yang tidak memengaruhi langkah berikutnya.

TOOL: ${toolName}
ISI:
${text}`;
}

/** Detects the SLM echoing back the prompt's placeholder template instead of a real brief. */
export function isPlaceholderBrief(brief: string): boolean {
	const text = brief.trim();
	if (!text) return true;
	const placeholders = [
		"[nama komponen/fungsi dan berkas target]",
		"[ringkasan masalah 1-2 kalimat]",
		"[poin-poin kriteria lulus pengujian]",
	];
	const hits = placeholders.filter((marker) => text.includes(marker)).length;
	return hits >= 2 || /^(TIDAK TERSEDIA|TIDAK DAPAT DITENTUKAN)/im.test(text);
}

/**
 * Per-request compressor prompt (Entity 2): compresses ONE actual LLM request
 * against the current CLM ledger, keeping intent, symbols, and constraints.
 */
export function buildRequestCompressPrompt(input: { rawRequest: string; ledger: string }): string {
	return `=== CATATAN KONTEKS SESI (CLM) ===
${input.ledger || "(kosong)"}
=== END CATATAN ===

=== REQUEST MENTAH KE LLM ===
${input.rawRequest}
=== END REQUEST ===

TUGAS KOMPRESI REQUEST SLM:
Padatkan request mentah di atas menjadi request padat untuk LLM cloud.
Pertahankan: tujuan user, path berkas, nama simbol/fungsi, angka, error, dan keputusan penting.
Lakukan grounding: hanya sebut nama fungsi/variabel yang benar-benar ada di request mentah.
Buang: boilerplate, log berulang, dan isi yang tidak memengaruhi langkah berikutnya.
Hasilkan output padat strictly dengan format berikut:

=== REQUEST PADAT ===
(maksimal ~150 kata, sudah mencakup tujuan + fakta penting)
=== END REQUEST PADAT ===`;
}

/** Extracts the compressed request block; falls back to the raw output when unmarked. */
export function parseCompressedRequest(raw: string): string {
	const match = raw.match(/=== REQUEST PADAT ===([\s\S]*?)=== END REQUEST PADAT ===/);
	const content = (match ? match[1] : raw).trim();
	return content || raw.trim();
}

/**
 * Parses briefs:
 * Architetural brief output.
 */
export function parseArchitecturalBrief(rawOutput: string): ArchitecturalBrief {
	const briefMatch = rawOutput.match(/=== ARCHITECTURAL BRIEF ===([\s\S]*?)=== END BRIEF ===/);
	const content = briefMatch ? briefMatch[1].trim() : rawOutput.trim();

	let targetFile: string | undefined;
	const fileMatch = content.match(/(?:in\s+|file:\s*|berkas:\s*|target:\s*)([a-zA-Z0-9_\-./\\]+\.[a-zA-Z0-9]+)/i);
	if (fileMatch) {
		targetFile = fileMatch[1];
	}

	const criteria: string[] = [];
	const lines = content.split("\n");
	for (const line of lines) {
		const trimmed = line.trim();
		if (trimmed.startsWith("-") || trimmed.startsWith("*") || /^\d+\./.test(trimmed)) {
			criteria.push(trimmed.replace(/^[-*\d.]+\s*/, ""));
		} else if (trimmed.toLowerCase().includes("criteria:") || trimmed.toLowerCase().includes("kriteria:")) {
			criteria.push(trimmed);
		}
	}

	return {
		raw: content,
		targetFile,
		criteria: criteria.length > 0 ? criteria : [content],
	};
}
