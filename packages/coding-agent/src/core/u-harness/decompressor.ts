import type { CanonicalPatch, TripletInput } from "./types.ts";

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
