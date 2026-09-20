/**
 * dsh-desktop-pet — host half.
 *
 * Owns the desktop pet process and its state channel.
 *
 * Responsibilities
 * ----------------
 * 1. Launch the pet window (`pet/pet.py`) through the harness subprocess seam
 *    so the pet's lifetime is tied to the harness: the seam terminates every
 *    managed process it started when the service disposes, so a pet can never
 *    outlive DSH unnoticed.
 * 2. Expose a small fenced JSON API the browser half uses to push the current
 *    session mood and to start/stop the pet.
 * 3. Keep a `state.json` on disk as the transport to the pet, written
 *    atomically. The pet polls it; nothing here needs to hold a socket open.
 *
 * Why files instead of a socket: the pet is a separate OS process with its own
 * event loop, and the DSH web server binds to an OS-assigned port that changes
 * on every launch. A file under the pet directory is a stable, debuggable
 * rendezvous that survives either side restarting.
 *
 * Layout (under `<DSH_HOME>/desktop-pet/` by default):
 *   state.json   host -> pet   (mood, visible)
 *   pet.json     pet  -> host  (alive, pid, x, y, mood, clicks)
 *   pos.json     pet  -> host  (remembered position)
 *   pet.log      pet  -> disk  (diagnostics)
 */

import { spawn as spawnProcess } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Plugin identity for cordis.yml rows. */
export const name = "dsh-desktop-pet";

/** Services required before mounting: the web routes and the subprocess seam. */
export const inject = ["webServer", "webRuntime", "subprocess"];

/** Route prefix owned by this plugin. */
const API_PREFIX = "/desktop-pet/api";

/** Max accepted request body. */
const MAX_BODY_BYTES = 64 * 1024;

// ── paths ──────────────────────────────────────────────────────────────────

/** Absolute path of this module, used to locate the bundled pet sources. */
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

/** Package root (one level above `lib/`). */
const PACKAGE_ROOT = dirname(MODULE_DIR);

/** The bundled pet launcher, shipped inside the package. */
const PET_SCRIPT = join(PACKAGE_ROOT, "pet", "pet.py");

/** Directory name for runtime state inside the DSH home. */
const RUNTIME_DIR_NAME = "desktop-pet";

/** The harness home, honouring `DSH_HOME` exactly like the official plugins. */
function dshHome() {
	return process.env.DSH_HOME && process.env.DSH_HOME.length > 0
		? process.env.DSH_HOME
		: join(homedir(), ".dsh");
}

/** Directory holding the pet's transport files. */
function runtimeDir(config) {
	return config.petDir && config.petDir.length > 0
		? config.petDir
		: join(dshHome(), RUNTIME_DIR_NAME);
}

function statePath(config) {
	return join(runtimeDir(config), "state.json");
}

function petInfoPath(config) {
	return join(runtimeDir(config), "pet.json");
}

// ── config ─────────────────────────────────────────────────────────────────

/**
 * Resolve the plugin configuration with documented defaults.
 *
 * All values are plain and optional so a profile can configure the plugin with
 * a single cordis.yml row; nothing here reads a secret.
 */
function resolveConfig(raw) {
	const config = raw && typeof raw === "object" ? raw : {};
	const pythonPath = typeof config.pythonPath === "string" && config.pythonPath.length > 0
		? config.pythonPath
		: defaultPythonPath();
	// Auto-start resolution order, most specific first:
	//   1. DSH_PET_AUTOSTART=0/1 — an environment kill switch that works even
	//      when the loader hands the plugin a schema-shaped default object.
	//   2. an explicit boolean in the plugin's own config row.
	//   3. on by default.
	// The loader can materialise defaults for undeclared config keys, so an
	// absent key must not be read as an opt-out; only a literal `false` from
	// either source disables the pet.
	const envFlag = process.env.DSH_PET_AUTOSTART;
	const autoStart = envFlag === "0" || envFlag === "false"
		? false
		: envFlag === "1" || envFlag === "true"
			? true
			: config.autoStart !== false;
	return {
		pythonPath,
		petDir: typeof config.petDir === "string" ? config.petDir : "",
		scale: typeof config.scale === "number" && config.scale > 0 ? config.scale : 1.0,
		pollMs: typeof config.pollMs === "number" && config.pollMs >= 60 ? config.pollMs : 250,
		autoStart,
		image: typeof config.image === "string" ? config.image : "",
	};
}

/**
 * Best-effort default interpreter.
 *
 * The pet needs PyQt5, which the harness's own embedded Python does not ship.
 * A user-created conda environment is the documented setup, so probe the
 * conventional conda locations before falling back to a bare `python` on PATH
 * (which may or may not have Qt — the pet reports that clearly in pet.log).
 */
function defaultPythonPath() {
	const candidates = [
		process.env.DSH_PET_PYTHON,
		"D:\\anaconda3\\envs\\dsh-pet\\python.exe",
		join(homedir(), "anaconda3", "envs", "dsh-pet", "python.exe"),
		join(homedir(), "miniconda3", "envs", "dsh-pet", "python.exe"),
		"C:\\ProgramData\\anaconda3\\envs\\dsh-pet\\python.exe",
	].filter((value) => typeof value === "string" && value.length > 0);
	for (const candidate of candidates) {
		try {
			if (existsSync(candidate)) return candidate;
		} catch {
			// Fall through to the next candidate.
		}
	}
	return "python";
}

// ── JSON transport ─────────────────────────────────────────────────────────

function readJson(file) {
	try {
		if (!existsSync(file)) return {};
		const parsed = JSON.parse(readFileSync(file, "utf8"));
		return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
	} catch {
		return {};
	}
}

function writeJson(file, value) {
	mkdirSync(dirname(file), { recursive: true });
	const tmp = `${file}.tmp`;
	const body = JSON.stringify(value);
	writeFileSync(tmp, body, { encoding: "utf8" });
	try {
		renameSync(tmp, file);
	} catch {
		// A Windows rename can lose a race with the pet reading the file; a
		// direct write is an acceptable fallback for this single-writer case.
		writeFileSync(file, body, { encoding: "utf8" });
	}
}

/**
 * JSON-stringify a value for diagnostics without ever throwing.
 *
 * The loader may hand the plugin a config object carrying functions or
 * circular references; a boot log line must not be the thing that breaks the
 * start path it is trying to describe.
 */
function safeStringify(value) {
	try {
		const text = JSON.stringify(value);
		if (typeof text === "string") return text.length > 400 ? `${text.slice(0, 400)}...` : text;
		return String(value);
	} catch {
		return "<unserializable>";
	}
}

/**
 * Append one line to `host.log` beside the pet's own files.
 *
 * The host half runs inside the harness process, where a plugin logger line
 * may never reach a file the user can inspect. A small side log makes the
 * start path debuggable after the fact — the question "why did the pet not
 * come up this launch?" is answerable only if the attempt was recorded.
 */
function appendBootLog(config, message) {
	try {
		const dir = runtimeDir(config);
		mkdirSync(dir, { recursive: true });
		const line = `[${new Date().toISOString()}] ${message}\n`;
		appendFileSync(join(dir, "host.log"), line, { encoding: "utf8" });
	} catch {
		// Diagnostics must never break the plugin.
	}
}

// ── pet process ────────────────────────────────────────────────────────────

/** Whether a pid currently names a live process. */
function isPidAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM means the process exists but belongs to someone else.
		return error?.code === "EPERM";
	}
}

/** Resolve once the pid is gone, or when the budget runs out. */
async function waitForPidExit(pid, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (!isPidAlive(pid)) return true;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	return !isPidAlive(pid);
}

/** Run a short-lived helper command, resolving regardless of its exit code. */
function runDetached(command, args) {
	return new Promise((resolve) => {
		try {
			const child = spawnProcess(command, args, { stdio: "ignore", windowsHide: true });
			child.on("close", () => resolve(true));
			child.on("error", () => resolve(false));
		} catch {
			resolve(false);
		}
	});
}

/**
 * Owns at most one pet process per plugin instance.
 *
 * The pet is spawned through the harness subprocess seam when that service is
 * present (so teardown is guaranteed), and through a detached child process
 * otherwise, which keeps the plugin usable in a plain node context.
 */
class PetController {
	constructor(ctx, config) {
		this.ctx = ctx;
		this.config = config;
		this.handle = null;
		this.fallbackChild = null;
		this.starting = null;
		// Clicks already delivered to the browser half. Seeded from disk so a
		// host restart does not replay clicks the user made before it.
		this.claimedClicks = this.clickCount();
	}

	/** Whether a pet is believed to be running (handle or reported pid). */
	isRunning() {
		if (this.handle !== null) return true;
		if (this.fallbackChild !== null && this.fallbackChild.exitCode === null) return true;
		const info = readJson(petInfoPath(this.config));
		if (info.alive !== true || typeof info.pid !== "number") return false;
		try {
			process.kill(info.pid, 0);
			return true;
		} catch {
			return false;
		}
	}

	/** Current pet facts as reported by the pet itself. */
	info() {
		return readJson(petInfoPath(this.config));
	}

	/** Push a mood (and optional visibility) to the pet. */
	setMood(mood, visible) {
		const patch = { mood, at: new Date().toISOString() };
		if (typeof visible === "boolean") patch.visible = visible;
		const next = { ...readJson(statePath(this.config)), ...patch };
		writeJson(statePath(this.config), next);
		return next;
	}

	/**
	 * Ask the pet to play its "poked" animation.
	 *
	 * A monotonically increasing counter rather than a boolean flag: the pet
	 * polls, so a flag would either be missed between polls or replay on every
	 * poll. With a counter the pet animates exactly once per bump, no matter
	 * how the poll intervals line up.
	 *
	 * @returns the new poke count.
	 */
	poke() {
		const current = readJson(statePath(this.config));
		const count = typeof current.pokes === "number" && Number.isFinite(current.pokes)
			? current.pokes + 1
			: 1;
		const next = { ...current, pokes: count, at: new Date().toISOString() };
		writeJson(statePath(this.config), next);
		return count;
	}

	/**
	 * Read the pet's click counter without acknowledging it.
	 * @returns the number of clicks the pet has ever reported.
	 */
	clickCount() {
		const info = readJson(petInfoPath(this.config));
		const value = info.clicks;
		return typeof value === "number" && Number.isFinite(value) ? value : 0;
	}

	/**
	 * Claim any click the pet recorded since the last claim.
	 *
	 * The pet appends to a monotonically increasing counter, so the host can
	 * tell "a new click happened" from "the same click is still in the file"
	 * without either side needing a queue. Claiming is the read-and-advance
	 * operation: it returns the pending click count and records it as consumed,
	 * so two browser tabs polling this cannot both react to one click.
	 *
	 * @returns the number of unclaimed clicks (0 when nothing is pending).
	 */
	claimClicks() {
		const info = readJson(petInfoPath(this.config));
		const total = typeof info.clicks === "number" && Number.isFinite(info.clicks) ? info.clicks : 0;
		const seen = this.claimedClicks;
		if (total <= seen) return 0;
		this.claimedClicks = total;
		return total - seen;
	}

	/**
	 * Start the pet if it is not already running.
	 * @returns the pid, or null when the spawn could not start.
	 */
	async start() {
		if (this.isRunning()) return this.info().pid ?? null;
		if (this.starting !== null) return this.starting;

		this.starting = (async () => {
			mkdirSync(runtimeDir(this.config), { recursive: true });
			if (!existsSync(PET_SCRIPT)) {
				throw new Error(`dsh-desktop-pet: pet launcher missing at ${PET_SCRIPT}`);
			}
			const argv = [
				this.config.pythonPath,
				PET_SCRIPT,
				"--pet-dir", runtimeDir(this.config),
				"--scale", String(this.config.scale),
				"--poll-ms", String(this.config.pollMs),
			];
			if (this.config.image) argv.push("--image", this.config.image);

			// Prefer the managed seam: it guarantees tree-scoped teardown.
			const subprocess = this.ctx.get("subprocess");
			if (subprocess && typeof subprocess.spawn === "function") {
				const handle = subprocess.spawn({
					argv,
					cwd: PACKAGE_ROOT,
					stdio: { stdin: "ignore", stdout: "inherit", stderr: "inherit" },
					graceMs: 3000,
				});
				this.handle = handle;
				handle.done.then(
					(outcome) => {
						if (this.handle === handle) this.handle = null;
						this.ctx.logger?.info?.(`[dsh-desktop-pet] pet exited (code ${outcome.exitCode})`);
					},
					(error) => {
						if (this.handle === handle) this.handle = null;
						this.ctx.logger?.warn?.(`[dsh-desktop-pet] pet failed: ${String(error)}`);
					},
				);
				return handle.pid;
			}

			// Fallback: a detached child for plain-node contexts.
			const child = spawnProcess(argv[0], argv.slice(1), {
				cwd: PACKAGE_ROOT,
				detached: true,
				stdio: "ignore",
				windowsHide: false,
			});
			child.unref();
			this.fallbackChild = child;
			return child.pid ?? null;
		})().finally(() => {
			this.starting = null;
		});

		return this.starting;
	}

	/** Stop the pet and wait briefly for it to go away. */
	async stop() {
		const info = readJson(petInfoPath(this.config));
		const pid = typeof info.pid === "number" && info.pid > 0 ? info.pid : null;

		// Ask the window to close politely first: on Windows a bare taskkill
		// (without /F) posts WM_CLOSE, which lets Qt run its closeEvent and
		// persist both the final position and the `alive:false` exit record.
		// A hard kill would leave a stale `alive:true` behind.
		if (pid !== null) {
			try {
				if (process.platform === "win32") {
					await runDetached("taskkill", ["/PID", String(pid), "/T"]);
				} else {
					process.kill(pid, "SIGTERM");
				}
			} catch {
				// Already gone, or the signal is not deliverable.
			}
			await waitForPidExit(pid, 2500);
		}

		if (this.handle !== null) {
			const handle = this.handle;
			this.handle = null;
			try {
				handle.terminate();
				await handle.waitForExit();
			} catch {
				// Teardown failures are not actionable here.
			}
		}
		if (this.fallbackChild !== null && this.fallbackChild.exitCode === null) {
			try {
				this.fallbackChild.kill();
			} catch {
				// Already gone.
			}
			this.fallbackChild = null;
		}

		// If the process is still alive after the polite request, force it.
		if (pid !== null && isPidAlive(pid)) {
			try {
				if (process.platform === "win32") {
					await runDetached("taskkill", ["/PID", String(pid), "/T", "/F"]);
				} else {
					process.kill(pid, "SIGKILL");
				}
			} catch {
				// Nothing further to try.
			}
			await waitForPidExit(pid, 1500);
		}

		// Never leave a stale liveness flag behind for the next start().
		const final = readJson(petInfoPath(this.config));
		if (final.alive === true) {
			writeJson(petInfoPath(this.config), {
				...final,
				alive: false,
				event: "quit",
				at: new Date().toISOString(),
			});
		}
		return true;
	}
}

// ── trust fence (same shape as the shipped plugins) ────────────────────────

function parseAuthority(authority) {
	try {
		return new URL(`http://${authority}`);
	} catch {
		return undefined;
	}
}

function isLoopbackHostname(hostname) {
	if (hostname === "localhost" || hostname === "[::1]") return true;
	const parts = hostname.split(".");
	return parts.length === 4
		&& parts[0] === "127"
		&& parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

function isTrustedAuthority(hostUrl, trustedHosts) {
	return trustedHosts.some((entry) => {
		const entryUrl = parseAuthority(entry);
		if (entryUrl === undefined) return false;
		return entryUrl.port === "" ? entryUrl.hostname === hostUrl.hostname : entryUrl.host === hostUrl.host;
	});
}

/** Loopback (or a configured trusted authority) plus same-origin markers only. */
function isTrustedApiRequest(req, trustedHosts) {
	const host = typeof req.headers.host === "string" ? req.headers.host : undefined;
	if (host === undefined) return false;
	const hostUrl = parseAuthority(host);
	if (hostUrl === undefined) return false;
	if (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, trustedHosts)) return false;
	if (req.headers["sec-fetch-site"] === "cross-site") return false;
	const origin = req.headers.origin;
	if (origin === undefined) return true;
	try {
		return new URL(origin).host === hostUrl.host;
	} catch {
		return false;
	}
}

// ── HTTP helpers ───────────────────────────────────────────────────────────

const PAYLOAD_TOO_LARGE = Symbol("payload-too-large");

function readJsonBody(req) {
	return new Promise((resolve) => {
		const chunks = [];
		let size = 0;
		let aborted = false;
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > MAX_BODY_BYTES && !aborted) {
				aborted = true;
				req.destroy();
				resolve(PAYLOAD_TOO_LARGE);
				return;
			}
			if (!aborted) chunks.push(chunk);
		});
		req.on("end", () => {
			if (aborted) return;
			try {
				resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
			} catch {
				resolve(null);
			}
		});
		req.on("error", () => {
			if (!aborted) resolve(null);
		});
	});
}

function writeJsonResponse(res, status, value) {
	res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
	res.end(JSON.stringify(value));
}

// ── plugin ─────────────────────────────────────────────────────────────────

/**
 * Host loader entry: own the pet process and mount the state API.
 * @param ctx - host cordis context (webServer, webRuntime, subprocess).
 * @param rawConfig - optional plugin configuration from the cordis row.
 */
export function apply(ctx, rawConfig) {
	const config = resolveConfig(rawConfig);
	const pet = new PetController(ctx, config);

	ctx.logger?.info?.(`[dsh-desktop-pet] pet runtime dir: ${runtimeDir(config)}`);
	ctx.logger?.info?.(`[dsh-desktop-pet] python: ${config.pythonPath}`);
	appendBootLog(config, `apply rawConfig=${safeStringify(rawConfig)} autoStart=${config.autoStart}`);

	// Route registration is the plugin's owned resource.
	ctx.effect(() => ctx.webServer.register({
		kind: "prefix",
		path: API_PREFIX,
		handler: async (req, res) => {
			if (!isTrustedApiRequest(req, ctx.webRuntime.trustedHosts)) {
				writeJsonResponse(res, 403, { ok: false, error: { code: "forbidden", message: "forbidden" } });
				return;
			}
			if (req.method !== "POST") {
				writeJsonResponse(res, 405, { ok: false, error: { code: "method-error", message: "method not allowed" } });
				return;
			}
			const contentType = typeof req.headers["content-type"] === "string"
				? req.headers["content-type"].toLowerCase()
				: "";
			if (!contentType.startsWith("application/json")) {
				writeJsonResponse(res, 415, { ok: false, error: { code: "unsupported-media-type", message: "content-type must be application/json" } });
				return;
			}

			const payload = await readJsonBody(req);
			if (payload === PAYLOAD_TOO_LARGE) {
				writeJsonResponse(res, 413, { ok: false, error: { code: "payload-too-large", message: "body too large" } });
				return;
			}
			if (payload === null || typeof payload !== "object" || typeof payload.method !== "string") {
				writeJsonResponse(res, 400, { ok: false, error: { code: "bad-request", message: "bad request" } });
				return;
			}

			try {
				switch (payload.method) {
					case "status": {
						writeJsonResponse(res, 200, {
							ok: true,
							value: {
								running: pet.isRunning(),
								info: pet.info(),
								pythonPath: config.pythonPath,
								petDir: runtimeDir(config),
								autoStart: config.autoStart,
								// Peek only: `status` is polled for display, so it
								// must not consume the click queue. The browser
								// half claims clicks through `clicks` below.
								pendingClicks: Math.max(0, pet.clickCount() - pet.claimedClicks),
							},
						});
						return;
					}
					case "clicks": {
						// Read-and-advance: exactly one caller sees a given click.
						const claimed = pet.claimClicks();
						writeJsonResponse(res, 200, { ok: true, value: { clicks: claimed } });
						return;
					}
					case "poke": {
						const pokes = pet.poke();
						writeJsonResponse(res, 200, { ok: true, value: { pokes } });
						return;
					}
					case "start": {
						const pid = await pet.start();
						writeJsonResponse(res, 200, { ok: true, value: { pid, running: pet.isRunning() } });
						return;
					}
					case "stop": {
						await pet.stop();
						writeJsonResponse(res, 200, { ok: true, value: { running: false } });
						return;
					}
					case "mood": {
						const mood = typeof payload.mood === "string" && payload.mood.length > 0 ? payload.mood : "idle";
						const state = pet.setMood(mood, typeof payload.visible === "boolean" ? payload.visible : undefined);
						writeJsonResponse(res, 200, { ok: true, value: state });
						return;
					}
					default: {
						writeJsonResponse(res, 404, { ok: false, error: { code: "not-found", message: `unknown method "${payload.method}"` } });
					}
				}
			} catch (error) {
				ctx.logger?.warn?.(`[dsh-desktop-pet] API error: ${String(error)}`);
				writeJsonResponse(res, 500, { ok: false, error: { code: "internal", message: "internal error" } });
			}
		},
	}), "dsh-desktop-pet: state API routes");

	// Auto-start the pet with the harness, and clean it up on teardown.
	//
	// The start is deferred by a short tick: `apply` runs while the profile is
	// still mounting, and the subprocess seam may not be resolvable yet. A
	// deferred start also lets the web server finish binding, so the browser
	// half's very first `start` call finds an already-live pet instead of
	// racing a spawn that has not happened.
	if (config.autoStart) {
		appendBootLog(config, "autoStart scheduled");
		const timer = setTimeout(() => {
			pet.start()
				.then((pid) => appendBootLog(config, `autoStart ok pid=${pid}`))
				.catch((error) => {
					appendBootLog(config, `autoStart failed: ${String(error)}`);
					ctx.logger?.warn?.(`[dsh-desktop-pet] pet auto-start failed: ${String(error)}`);
				});
		}, 1200);
		if (typeof timer.unref === "function") timer.unref();
	} else {
		appendBootLog(config, "autoStart disabled by config");
	}

	ctx.effect(() => () => {
		// The subprocess seam terminates managed children on its own disposal,
		// but the fallback path and the pet's position save both want an
		// explicit stop.
		void pet.stop();
	}, "dsh-desktop-pet: stop pet on teardown");
}

export { PetController, resolveConfig, runtimeDir };
