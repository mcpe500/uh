/**
 * Lifecycle manager for an external Janas OpenAI-compatible SLM server.
 *
 * Janas stays a separate process: uh only starts it, talks HTTP to it, and stops it.
 */
import type { ChildProcessByStdio } from "node:child_process";
import { createServer } from "node:net";
import type { Readable } from "node:stream";
import { spawnProcess } from "../../utils/child-process.ts";
import type { UHarnessSettings } from "../settings-schema.ts";

export interface JanasServerOptions {
	/** How long to wait for `/health` before giving up. Default: 60 seconds. */
	startupTimeoutMs?: number;
	/** Delay between health checks. Default: 100 milliseconds. */
	pollIntervalMs?: number;
}

type JanasChild = ChildProcessByStdio<null, Readable, Readable>;

function getFreePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.unref();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (typeof address === "object" && address) resolve(address.port);
			else reject(new Error("Could not allocate a local port"));
			server.close(() => {});
		});
	});
}

function waitForExit(child: JanasChild): Promise<number | null> {
	return new Promise((resolve) => {
		if (child.exitCode !== null) {
			resolve(child.exitCode);
			return;
		}
		child.once("exit", (code) => resolve(code));
	});
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export class JanasServer {
	private readonly settings: UHarnessSettings;
	private readonly options: JanasServerOptions;
	private child?: JanasChild;
	private _baseUrl?: string;
	private stderrTail = "";

	constructor(settings: UHarnessSettings, options: JanasServerOptions = {}) {
		this.settings = settings;
		this.options = options;
	}

	get running(): boolean {
		return this.child !== undefined && this.child.exitCode === null;
	}

	get baseUrl(): string {
		if (!this._baseUrl) throw new Error("Janas server is not running");
		return this._baseUrl;
	}

	/** Start the server if it is not already running, and wait until its health endpoint answers. */
	async start(): Promise<string> {
		if (this.running && this._baseUrl) return this._baseUrl;
		await this.stop();

		const executable = this.settings.slm?.executablePath ?? "janas-server";
		const model = this.settings.slm?.model ?? "Qwen/Qwen2.5-Coder-1.5B-Instruct";
		const apiKey = this.settings.slm?.apiKey ?? "none";
		const port = await getFreePort();
		const child = spawnProcess(
			executable,
			[model, "--host", "127.0.0.1", "--port", String(port), "--api-key", apiKey],
			{ stdio: ["ignore", "pipe", "pipe"] },
		);
		this.child = child;
		this._baseUrl = `http://127.0.0.1:${port}/v1`;
		this.stderrTail = "";
		child.stderr?.on("data", (chunk: Buffer | string) => {
			this.stderrTail = `${this.stderrTail}${chunk.toString()}`.slice(-2000);
		});

		const exitPromise = new Promise<never>((_, reject) => {
			child.once("error", (error) => {
				reject(new Error(`Could not start Janas server: ${error.message}\n${this.stderrTail}`));
			});
			waitForExit(child).then((code) => {
				reject(new Error(`Janas server exited before becoming healthy (code ${code})\n${this.stderrTail}`));
			});
		});

		try {
			await Promise.race([this.waitUntilHealthy(), exitPromise]);
		} catch (error) {
			await this.stop();
			throw error;
		}
		return this._baseUrl;
	}

	/** Terminate the managed server. Safe to call more than once. */
	async stop(): Promise<void> {
		const child = this.child;
		if (!child) return;
		this.child = undefined;
		this._baseUrl = undefined;
		if (child.exitCode !== null) return;
		const killTimer = setTimeout(() => child.kill("SIGKILL"), 1000);
		child.kill("SIGTERM");
		await waitForExit(child);
		clearTimeout(killTimer);
	}

	private async waitUntilHealthy(): Promise<void> {
		const deadline = Date.now() + (this.options.startupTimeoutMs ?? 60_000);
		const interval = this.options.pollIntervalMs ?? 100;
		while (Date.now() < deadline) {
			if (await this.isHealthy()) return;
			await delay(interval);
		}
		throw new Error(`Janas server did not become healthy in time\nstderr:${this.stderrTail}`);
	}

	private async isHealthy(): Promise<boolean> {
		if (!this._baseUrl) return false;
		try {
			const origin = new URL(this._baseUrl).origin;
			const response = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(500) });
			return response.ok;
		} catch {
			return false;
		}
	}
}
