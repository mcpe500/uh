import type { CanonicalPatch, TripletInput } from "./types.ts";

/**
 * Assembles the per-request triplet decompression prompt (Entity 4): one actual LLM
 * core answer is expanded against the raw context and the compressed request.
 */
export function buildRequestExpandPrompt(input: {
	rawContext: string;
	compressedRequest: string;
	coreAnswer: string;
}): string {
	return `=== 1. KONTEKS MENTAH TERKAIT ===
${input.rawContext || "(tidak ada konteks mentah terkait)"}

=== 2. REQUEST PADAT ===
${input.compressedRequest}

=== 3. JAWABAN INTI CLOUD ===
${input.coreAnswer}

TUGAS DEKOMPRESI BALASAN SLM:
Susun balasan lengkap yang siap dieksekusi oleh Coding Agent berdasarkan jawaban inti cloud di atas dan konteks mentah terkait.
Aturan:
1. Jika balasan memuat perubahan berkas, sertakan isi lengkap berkas dengan format:
### FILE: <path_berkas>
diikuti isi lengkap berkas tersebut (tanpa placeholder atau komentar TODO).
2. Jika balasan berupa jawaban/penjelasan/keputusan, tulis versi lengkap dan jelas yang siap dibaca user.
3. Pertahankan nama simbol, path, dan angka dari konteks mentah.
4. Akhiri output dengan tepat satu baris berformat:
VERDICT: PASS|FAIL|PARTIAL|UNKNOWN`;
}

/** Removes the trailing VERDICT line so it never reaches the agent loop. */
export function stripVerdictLine(output: string): string {
	return output.replace(/\n?VERDICT:\s*(PASS|FAIL|PARTIAL|UNKNOWN)\s*$/i, "").trim();
}

/** Deterministically turns extracted canonical patches into write tool call parts. */
export function patchesToToolCalls(
	patches: Array<{ filePath: string; content: string }>,
): Array<{ type: "toolCall"; id: string; name: string; arguments: { path: string; content: string } }> {
	return patches.map((patch, index) => ({
		type: "toolCall" as const,
		id: `uh_expand_${Date.now()}_${index}`,
		name: "write",
		arguments: { path: patch.filePath, content: patch.content },
	}));
}

/**
 * Assembles the Triplet Input Confluence required by the SLM Outbound Decompressor.
 * Invariant: Must combine (1) Original Code + (2) Brief + (3) Blueprint.
 */
export function formatTripletPrompt(triplet: TripletInput): string {
	const filesContent = triplet.originalFiles
		.map((f) => `--- BERKAS: ${f.path} ---\n${f.content}\n--- SELESAI BERKAS ---`)
		.join("\n\n");

	return `=== 1. KONTEKS KODE ASLI ===
${filesContent}

=== 2. ARCHITECTURAL BRIEF ===
${triplet.architecturalBrief}

=== 3. BLUEPRINT SOLUSI CLOUD ===
${triplet.solutionBlueprint}

TUGAS DEKOMPRESI KELUARAN:
Rekonstruksi kode secara lengkap tanpa placeholder atau komentar TODO.
Pertahankan format indentasi dan import eksisting.
Setiap perubahan berkas WAJIB diawali dengan:
### FILE: <path_berkas>
diikuti isi lengkap berkas tersebut.`;
}

/**
 * Assembles the per-step decompression prompt: expands one assistant step against the
 * brief and verifies the brief's passing criteria, ending with a `VERDICT:` line.
 */
export function buildStepDecompressPrompt(brief: string, assistantOutput: string): string {
	return `=== 1. ARCHITECTURAL BRIEF ===
${brief}
=== END BRIEF ===

=== 2. JAWABAN ASSISTANT (LANGKAH INI) ===
${assistantOutput}
=== END ===

TUGAS DEKOMPRESI & VERIFIKASI SLM:
1. Rekonstruksi penjelasan lengkap dari langkah assistant di atas berdasarkan brief, tanpa placeholder.
2. Nilai setiap passing criteria pada brief terhadap jawaban tersebut (satu baris bukti per kriteria).
3. Akhiri output dengan tepat satu baris berformat:
VERDICT: PASS|FAIL|PARTIAL|UNKNOWN`;
}

/** Parses the trailing `VERDICT:` marker; anything unparseable stays UNKNOWN. */
export function parseVerdict(output: string): "PASS" | "FAIL" | "PARTIAL" | "UNKNOWN" {
	const match = output.match(/VERDICT:\s*(PASS|FAIL|PARTIAL|UNKNOWN)/i);
	return (match?.[1]?.toUpperCase() as "PASS" | "FAIL" | "PARTIAL" | "UNKNOWN") ?? "UNKNOWN";
}

/**
 * Deterministically extracts canonical patches marked with `### FILE: <path>` from model output.
 */
export function extractCanonicalPatches(output: string, marker: string = "### FILE:"): CanonicalPatch[] {
	const patches: CanonicalPatch[] = [];
	const escapedMarker = marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const regex = new RegExp(`(?:^|\\n)${escapedMarker}\\s*([^\\n]+)\\n([\\s\\S]*?)(?=(?:\\n${escapedMarker}|$))`, "g");

	let match: RegExpExecArray | null = regex.exec(output);
	while (match !== null) {
		const filePath = match[1].trim();
		const rawContent = match[2];
		// Strip markdown code fences if wrapped
		const cleanContent = rawContent
			.replace(/^```[a-zA-Z0-9_-]*\n/, "")
			.replace(/\n```\s*$/, "")
			.trim();

		if (filePath) {
			patches.push({
				filePath,
				content: cleanContent,
			});
		}
		match = regex.exec(output);
	}

	return patches;
}
