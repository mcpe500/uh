import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createWrapper, parseArgs, removeWrapper } from "./pi-install.mjs";

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
