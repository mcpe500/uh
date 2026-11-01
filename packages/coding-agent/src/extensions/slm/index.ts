/**
 * Slash commands for managing the U-Harness SLM endpoint and model from inside pi.
 *
 * The commands are intentionally small: `/slm-providers` lists the providers in
 * models.json (the same snapshot `/models` reads), `/slm-models` opens a selection
 * menu over that file's models and persists the pick, `/slm-log` shows recent
 * U-Harness SLM debug entries, and `/slm-set` sets a model selection directly.
 */
import { readFileSync } from "node:fs";
import { getSettingsPath } from "../../config.ts";
import type { ExtensionAPI } from "../../core/extensions/types.ts";
import { isSlmDebugEnabled, slmDebugLogPath } from "../../core/u-harness/debug-log.ts";
import { getRunningDebugUiUrl } from "../../core/u-harness/debug-server.ts";
import { listSlmModels, loadSlmCatalog, parseSlmModelEntry, parseSlmSetArgs, setSlmSettings } from "./slm-config.ts";

export default function slmExtension(pi: ExtensionAPI): void {
	pi.registerCommand("slm-providers", {
		description: "List SLM providers from models.json",
		handler: async (_args, ctx) => {
			try {
				const catalog = await loadSlmCatalog();
				ctx.ui.notify(
					catalog.length > 0
						? catalog
								.map((entry) => {
									const name = entry.name ? ` (${entry.name})` : "";
									const count = entry.models.length === 1 ? "1 model" : `${entry.models.length} models`;
									return `${entry.provider}${name} — ${entry.baseUrl ?? "(provider default baseUrl)"} — ${count}`;
								})
								.join("\n")
						: "No providers found in models.json",
				);
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.registerCommand("slm-models", {
		description: "Select an SLM model from models.json",
		handler: async (_args, ctx) => {
			try {
				const catalog = await loadSlmCatalog();
				const entries = catalog.flatMap((entry) => entry.models.map((model) => `${entry.provider}/${model}`));
				if (entries.length === 0) {
					ctx.ui.notify("No models found in models.json");
					return;
				}
				const selected = await ctx.ui.select("SLM model", entries);
				if (!selected) return;
				const parsed = parseSlmModelEntry(selected);
				if (!parsed) {
					ctx.ui.notify(`Invalid model entry: ${selected}`, "error");
					return;
				}
				setSlmSettings(getSettingsPath(), { provider: parsed.provider, model: parsed.model });
				ctx.ui.notify(`SLM model set to ${parsed.model} (${parsed.provider})`);
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.registerCommand("slm-log", {
		description: "Show recent U-Harness SLM debug log entries (set UH_SLM_DEBUG=1 to record)",
		handler: async (_args, ctx) => {
			if (!isSlmDebugEnabled()) {
				ctx.ui.notify("SLM debug logging is off. Start uh with UH_SLM_DEBUG=1 to record SLM requests.");
				return;
			}
			try {
				const logPath = slmDebugLogPath();
				const raw = readFileSync(logPath, "utf8").trim();
				const lines = raw ? raw.split("\n").slice(-30) : [];
				const uiUrl = getRunningDebugUiUrl();
				const header = uiUrl ? `Debug UI: ${uiUrl}` : "Debug UI off (start with UH_SLM_DEBUG=1)";
				ctx.ui.notify(
					lines.length > 0
						? `${header}\n${logPath}\n\n${lines.join("\n")}`
						: `${header}\nLog is empty: ${logPath}`,
				);
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.registerCommand("slm-set", {
		description: "Set the U-Harness SLM model, or `<provider> <model>` such as `janas qwen3.5-2b`",
		handler: async (args, ctx) => {
			const requested = args.trim();
			try {
				const parsed = parseSlmSetArgs(requested);
				const model =
					parsed?.model ?? (await ctx.ui.select("SLM model", await listSlmModels(pi.getSettings().uHarness)));
				if (!model) return;
				setSlmSettings(getSettingsPath(), {
					model,
					...(parsed?.provider ? { provider: parsed.provider } : {}),
					...(parsed?.executablePath ? { executablePath: parsed.executablePath } : {}),
				});
				ctx.ui.notify(`SLM model set to ${model}${parsed?.provider ? ` (${parsed.provider})` : ""}`);
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});
}
