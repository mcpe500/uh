import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname } from "path";

/**
 * Context Language Model (CLM) Working Memory Manager.
 * Implements context-as-an-editable-file paradigm (arXiv:2609.37725).
 */
export class ContextLanguageModel {
	readonly workingMemoryPath: string;

	constructor(workingMemoryPath: string = ".context/working_memory.md") {
		this.workingMemoryPath = workingMemoryPath;
	}

	/**
	 * Renders the initial working memory template.
	 */
	renderInitialMemory(task: string): string {
		return `# Working Memory (CLM)

## CURRENT TASK
${task}

## ARCHITECTURAL BRIEF
(Pending compression)

## EXECUTION LOG & TRACE
(Awaiting execution)

## FAILURE TRACE
(None)
`;
	}

	/**
	 * Reads the current working memory file from disk, creating default if missing.
	 */
	loadMemory(defaultTask: string = ""): string {
		if (existsSync(this.workingMemoryPath)) {
			return readFileSync(this.workingMemoryPath, "utf-8");
		}
		const initial = this.renderInitialMemory(defaultTask);
		this.saveMemory(initial);
		return initial;
	}

	/**
	 * Persists memory content to disk.
	 */
	saveMemory(content: string): void {
		const dir = dirname(this.workingMemoryPath);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}
		writeFileSync(this.workingMemoryPath, content, "utf-8");
	}

	/**
	 * Updates a specific Markdown section within the working memory content.
	 */
	updateSection(existingContent: string, sectionTitle: string, newSectionContent: string): string {
		const escapedTitle = sectionTitle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const sectionRegex = new RegExp(`(##\\s+${escapedTitle}\\n)([\\s\\S]*?)(?=\\n##\\s+|$)`);

		if (sectionRegex.test(existingContent)) {
			return existingContent.replace(sectionRegex, `$1${newSectionContent}\n`);
		}

		// If section not found, append at the end
		return `${existingContent.trim()}\n\n## ${sectionTitle}\n${newSectionContent}\n`;
	}

	/**
	 * Compresses raw verbose error/test output into a Dense Failure Trace.
	 */
	compressFailureLog(rawLog: string): string {
		const lines = rawLog.split("\n");
		// Extract error lines, assertion failures, and bottom summary
		const errorLines = lines.filter((line) => {
			const lower = line.toLowerCase();
			return (
				lower.includes("error") ||
				lower.includes("failed") ||
				lower.includes("failure") ||
				lower.includes("assert") ||
				lower.includes("exception") ||
				lower.includes("traceback") ||
				line.trim().startsWith("E ") ||
				line.trim().startsWith("> ")
			);
		});

		if (errorLines.length === 0) {
			// Fallback: take first 10 lines
			return lines.slice(0, 10).join("\n");
		}

		// Keep up to 15 key error lines
		return errorLines.slice(0, 15).join("\n");
	}
}
