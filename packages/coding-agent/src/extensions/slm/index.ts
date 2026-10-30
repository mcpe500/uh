/**
 * Slash commands for managing the U-Harness SLM endpoint and model from inside pi.
 *
 * The commands are intentionally small: `/slm-providers` shows the active SLM,
 * `/slm-models` lists what the endpoint exposes, and `/slm-set` persists a model
 * selection into the global settings file.
 */
import { getSettingsPath } from "../../config.ts";
import type { ExtensionAPI } from "../../core/extensions/types.ts";
import { getSlmProviderInfo, listSlmModels, setSlmSettings } from "./slm-config.ts";

export default function slmExtension(pi: ExtensionAPI): void {
	pi.registerCommand("slm-providers", {
		description: "Show the active U-Harness SLM provider",
		handler: async (_args, ctx) => {
			const info = getSlmProviderInfo(pi.getSettings().uHarness);
			ctx.ui.notify(`${info.provider} — ${info.baseUrl} (${info.model})`);
		},
	});

	pi.registerCommand("slm-models", {
		description: "List models exposed by the U-Harness SLM endpoint",
		handler: async (_args, ctx) => {
			try {
				const models = await listSlmModels(pi.getSettings().uHarness);
				ctx.ui.notify(models.length > 0 ? models.join("\n") : "No SLM models found");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.registerCommand("slm-set", {
		description: "Set the U-Harness SLM model (optionally pass a model id)",
		handler: async (args, ctx) => {
			const requested = args.trim();
			try {
				const model =
					requested || (await ctx.ui.select("SLM model", await listSlmModels(pi.getSettings().uHarness)));
				if (!model) return;
				setSlmSettings(getSettingsPath(), { model });
				ctx.ui.notify(`SLM model set to ${model}`);
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});
}
