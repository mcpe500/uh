import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { configureJanas, createWrapper, parseArgs, removeWrapper } from "./pi-install.mjs";

test("parseArgs defaults to install", () => {
	const { mode, options } = parseArgs([]);
	assert.equal(mode, "install");
	assert.equal(options.branch, process.env.UH_BRANCH || "main");
	assert.equal(options.installDir, process.env.UH_INSTALL_DIR || path.join(os.homedir(), ".local", "share", "uh"));
});

test("parseArgs accepts update options", () => {
	const { mode, options } = parseArgs(["update", "--branch", "feat/test", "--bin-dir", "/tmp/uh-bin"]);
	assert.equal(mode, "update");
	assert.equal(options.branch, "feat/test");
	assert.equal(options.binDir, "/tmp/uh-bin");
});

test("parseArgs accepts Janas setup options", () => {
	const { options } = parseArgs([
		"install",
		"--setup-janas",
		"--janas-executable",
		"/usr/local/bin/janas-server",
		"--janas-model",
		"test-model",
	]);
	assert.equal(options.setupJanas, true);
	assert.equal(options.janasExecutable, "/usr/local/bin/janas-server");
	assert.equal(options.janasModel, "test-model");
});

test("parseArgs rejects unknown modes", () => {
	assert.throws(() => parseArgs(["frobnicate"]), /Unknown mode/);
});

test("createWrapper creates and removes a Unix wrapper", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "uh-installer-"));
	const installDir = path.join(root, "repo");
	const binDir = path.join(root, "bin");
	const cli = path.join(installDir, "packages", "coding-agent", "dist", "bundle", "cli.js");
	fs.mkdirSync(path.dirname(cli), { recursive: true });
	fs.writeFileSync(cli, "#!/usr/bin/env node\n", "utf8");

	createWrapper({ installDir, binDir });
	const wrapper = path.join(binDir, "uh");
	assert.equal(fs.lstatSync(wrapper).isSymbolicLink(), true);
	assert.equal(fs.readlinkSync(wrapper), cli);
	assert.equal(fs.statSync(cli).mode & 0o111, 0o111);

	removeWrapper({ binDir });
	assert.equal(fs.existsSync(wrapper), false);
});

test("configureJanas writes external Janas settings without dropping other settings", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "uh-janas-setup-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
	fs.mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
	const settingsPath = path.join(process.env.PI_CODING_AGENT_DIR, "settings.json");
	fs.writeFileSync(
		settingsPath,
		JSON.stringify({ theme: "dark", uHarness: { pipeline: "baseline", slm: { model: "old-model" } } }),
	);

	try {
		configureJanas({
			setupJanas: true,
			janasExecutable: process.execPath,
			janasModel: "test-model",
		});

		const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
		assert.equal(settings.theme, "dark");
		assert.equal(settings.uHarness.pipeline, "u-shaped");
		assert.equal(settings.uHarness.slm.provider, "janas");
		assert.equal(settings.uHarness.slm.model, "test-model");
		assert.equal(settings.uHarness.slm.executablePath, path.resolve(process.execPath));
		assert.equal(settings.uHarness.slm.apiKey, "none");
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	}
});

test("configureJanas rejects a missing explicit executable", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "uh-janas-missing-"));
	assert.throws(
		() =>
			configureJanas({
				setupJanas: true,
				janasExecutable: path.join(root, "missing-janas-server"),
				janasModel: "test-model",
			}),
		/Janas executable not found/u,
	);
});
