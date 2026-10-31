/**
 * Slash commands for managing the U-Harness SLM endpoint and model from inside pi.
 *
 * The commands are intentionally small: `/slm-providers` lists the providers in
 * models.json (the same snapshot `/models` reads), `/slm-models` lists that file's
 * models as `provider/id`, and `/slm-set` persists a model selection into the
 * global settings file.
 */
import { getSettingsPath } from "../../config.ts";
import type { ExtensionAPI } from "../../core/extensions/types.ts";
import { listSlmModels, loadSlmCatalog, parseSlmSetArgs, setSlmSettings } from "./slm-config.ts";

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
		description: "List models from models.json as provider/id",
		handler: async (_args, ctx) => {
			try {
				const catalog = await loadSlmCatalog();
				const models = catalog.flatMap((entry) => entry.models.map((model) => `${entry.provider}/${model}`));
				ctx.ui.notify(models.length > 0 ? models.join("\n") : "No models found in models.json");
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
