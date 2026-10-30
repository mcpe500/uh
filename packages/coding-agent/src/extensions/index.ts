import type { InlineExtension } from "../core/extensions/types.ts";
import codemodeExtension from "./codemode/index.ts";
import freeUhProviderExtension from "./free-uh-provider/index.ts";
import llamaExtension from "./llama/index.ts";
import mcpExtension from "./mcp/index.ts";
import slmExtension from "./slm/index.ts";
import toolSearchExtension from "./tool-search/index.ts";
import uHarnessExtension from "./u-harness/index.ts";

export const builtInExtensions: InlineExtension[] = [
	{ name: "llama.cpp", factory: llamaExtension, builtin: true },
	{ name: "free-uh-provider", factory: freeUhProviderExtension, builtin: true },
	{ name: "slm", factory: slmExtension, builtin: true },
	{ name: "u-harness", factory: uHarnessExtension, builtin: true },
	// Replaceable: an extension that registers `codemode`, `tool_search`, or `/mcp` (such as a third-party
	// MCP extension) takes over instead of running alongside the built-in one.
	{ name: "codemode", factory: codemodeExtension, replaceable: true, builtin: true },
	{ name: "tool-search", factory: toolSearchExtension, replaceable: true, builtin: true },
	{ name: "mcp", factory: mcpExtension, replaceable: true, builtin: true },
];
