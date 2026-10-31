/**
 * Cross-platform installer for the U-Harness fork.
 *
 * The installer keeps Janas external: it only clones or updates this repository,
 * builds it, and creates a wrapper for the built coding-agent CLI.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_REPO_URL = "https://github.com/mcpe500/uh.git";
const DEFAULT_BRANCH = "main";
const DEFAULT_INSTALL_DIR = path.join(os.homedir(), ".local", "share", "uh");
const DEFAULT_BIN_DIR = path.join(os.homedir(), ".local", "bin");

function run(command, args, options = {}) {
	const result = spawnSync(command, args, {
		stdio: "inherit",
		...options,
	});
	if (result.status !== 0) {
		throw new Error(`${command} ${args.join(" ")} failed`);
	}
}

function ensureTool(name) {
	const result = spawnSync(name, ["--version"], { stdio: "ignore" });
	if (result.status !== 0) throw new Error(`${name} is required`);
}

function nodeMajor() {
	return Number(process.versions.node.split(".")[0]);
}

function parseArgs(argv) {
	const mode = argv[0] || "install";
	const options = {
		removeRepo: process.env.UH_REMOVE_REPO === "1",
		repoUrl: process.env.UH_REPO_URL || DEFAULT_REPO_URL,
		branch: process.env.UH_BRANCH || DEFAULT_BRANCH,
		installDir: process.env.UH_INSTALL_DIR || DEFAULT_INSTALL_DIR,
		binDir: process.env.UH_BIN_DIR || DEFAULT_BIN_DIR,
	};

	for (let i = 1; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--remove-repo") options.removeRepo = true;
		else if (arg === "--repo-url") options.repoUrl = argv[++i];
		else if (arg === "--branch") options.branch = argv[++i];
		else if (arg === "--install-dir") options.installDir = argv[++i];
		else if (arg === "--bin-dir") options.binDir = argv[++i];
		else if (arg === "--help" || arg === "-h") {
			console.log("Usage: pi-install.mjs <install|update|uninstall> [options]");
			process.exit(0);
		} else {
			throw new Error(`Unknown option: ${arg}`);
		}
	}

	if (!["install", "update", "uninstall"].includes(mode)) {
		throw new Error(`Unknown mode: ${mode}`);
	}
	return { mode, options };
}

function ensurePrerequisites() {
	ensureTool("git");
	ensureTool("node");
	ensureTool("npm");
	if (nodeMajor() < 22) throw new Error("Node.js 22.19 or newer is required");
}

function cloneOrUpdate(options, updateOnly) {
	const gitDir = path.join(options.installDir, ".git");

	if (fs.existsSync(gitDir)) {
		run("git", ["-C", options.installDir, "fetch", "--all", "--tags"]);
		run("git", ["-C", options.installDir, "checkout", options.branch]);
		run("git", ["-C", options.installDir, "pull", "--ff-only", "origin", options.branch]);
		return;
	}

	if (updateOnly) throw new Error(`Not a git repository: ${options.installDir}`);
	if (fs.existsSync(options.installDir)) {
		throw new Error(`Install directory exists but is not a git repository: ${options.installDir}`);
	}

	fs.mkdirSync(path.dirname(options.installDir), { recursive: true });
	run("git", ["clone", "--branch", options.branch, "--depth", "1", options.repoUrl, options.installDir]);
}

function build(options) {
	run("npm", ["install", "--ignore-scripts"], { cwd: options.installDir });
	run("npm", ["run", "build:offline"], { cwd: options.installDir });
}

function cliPath(options) {
	return path.join(options.installDir, "packages", "coding-agent", "dist", "bundle", "cli.js");
}

function createWrapper(options) {
	const cli = cliPath(options);
	if (!fs.existsSync(cli)) throw new Error(`Built CLI not found: ${cli}`);

	fs.mkdirSync(options.binDir, { recursive: true });

	if (process.platform === "win32") {
		const wrapper = path.join(options.binDir, "pi.cmd");
		fs.writeFileSync(wrapper, `@echo off\r\nnode "${cli}" %*\r\n`, "utf8");
	} else {
		const wrapper = path.join(options.binDir, "pi");
		try {
			fs.rmSync(wrapper, { force: true });
		} catch {
			// Ignore a missing wrapper; a non-file entry is reported by symlinkSync.
		}
		fs.symlinkSync(cli, wrapper);
		fs.chmodSync(cli, 0o755);
	}

	const wrapperName = process.platform === "win32" ? "pi.cmd" : "pi";
	console.log(`U-Harness installed: ${path.join(options.binDir, wrapperName)}`);
	if (!process.env.PATH.split(path.delimiter).includes(options.binDir)) {
		console.log(`Add ${options.binDir} to PATH, then run: pi`);
	}
}

function removeWrapper(options) {
	const names = process.platform === "win32" ? ["pi.cmd"] : ["pi"];
	for (const name of names) {
		try {
			fs.rmSync(path.join(options.binDir, name), { force: true });
		} catch {
			// The wrapper may already be absent.
		}
	}
}

function install(options) {
	ensurePrerequisites();
	cloneOrUpdate(options, false);
	build(options);
	createWrapper(options);
}

function update(options) {
	ensurePrerequisites();
	cloneOrUpdate(options, true);
	build(options);
	createWrapper(options);
}

function uninstall(options) {
	removeWrapper(options);
	if (options.removeRepo) {
		fs.rmSync(options.installDir, { recursive: true, force: true });
	}
	console.log("U-Harness uninstalled.");
}

function main() {
	if (process.argv.slice(2).includes("--help") || process.argv.slice(2).includes("-h")) {
		console.log("Usage: pi-install.mjs <install|update|uninstall> [options]");
		return;
	}
	const { mode, options } = parseArgs(process.argv.slice(2));
	try {
		if (mode === "install") install(options);
		else if (mode === "update") update(options);
		else uninstall(options);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	}
}

if (process.argv[1]?.endsWith("pi-install.mjs")) {
	main();
}

export { parseArgs, createWrapper, removeWrapper, cliPath };
