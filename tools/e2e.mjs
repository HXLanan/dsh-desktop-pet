/**
 * End-to-end check: start the real pet through the plugin's own controller,
 * confirm it reports in through pet.json, drive a mood change, then stop it.
 *
 * Run:  node tools/e2e.mjs
 */

import { PetController, resolveConfig, runtimeDir } from "../lib/index.js";
import { readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";

const config = resolveConfig({});
const dir = runtimeDir(config);
const petInfo = join(dir, "pet.json");
const stateFile = join(dir, "state.json");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function readJson(path) {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return null;
	}
}

async function waitFor(predicate, { timeoutMs = 15000, intervalMs = 250, label = "condition" } = {}) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const value = await predicate();
		if (value) return value;
		await sleep(intervalMs);
	}
	throw new Error(`timed out waiting for ${label}`);
}

/** Context stub with a real subprocess implementation (detached child). */
function makeContext() {
	return {
		logger: {
			info: (m) => console.log(`INFO  ${m}`),
			warn: (m) => console.log(`WARN  ${m}`),
		},
		// No subprocess service -> the controller uses its detached fallback,
		// which is exactly the path a plain-node run takes.
		get: () => undefined,
	};
}

let failures = 0;
const check = (label, condition) => {
	console.log(`${condition ? "PASS" : "FAIL"}  ${label}`);
	if (!condition) failures += 1;
};

async function main() {
	console.log(`pet dir    : ${dir}`);
	console.log(`python     : ${config.pythonPath}\n`);

	// Start from a clean slate so stale liveness data cannot mislead us.
	for (const file of [petInfo, stateFile, join(dir, "pet.log")]) {
		if (existsSync(file)) rmSync(file, { force: true });
	}

	const controller = new PetController(makeContext(), config);

	check("controller reports not running initially", controller.isRunning() === false);

	const pid = await controller.start();
	console.log(`started pid: ${pid}`);
	check("start returned a pid", typeof pid === "number" && pid > 0);

	const info = await waitFor(
		() => {
			const current = readJson(petInfo);
			return current && current.ready === true ? current : null;
		},
		{ label: "pet.json ready" },
	);
	console.log(`pet reported : ${JSON.stringify(info)}`);
	check("pet reports alive", info.alive === true);
	check("pet reports a coordinate", typeof info.x === "number" && typeof info.y === "number");

	check("controller sees it running", controller.isRunning() === true);

	// Drive a mood change and confirm the pet acknowledges it.
	controller.setMood("working");
	const acked = await waitFor(
		() => {
			const current = readJson(petInfo);
			return current && current.mood === "working" ? current : null;
		},
		{ label: "mood acknowledgement" },
	);
	check("pet acknowledged mood=working", acked.mood === "working");

	// Simulate a pet click the way the window itself records one, then confirm
	// the host can claim it exactly once.
	const clicksBefore = readJson(petInfo)?.clicks ?? 0;
	controller.claimedClicks = clicksBefore;
	const { default: fs } = await import("node:fs");
	const current = readJson(petInfo) ?? {};
	fs.writeFileSync(petInfo, JSON.stringify({ ...current, clicks: clicksBefore + 1, event: "click" }), "utf8");
	const claimed = controller.claimClicks();
	check("one click is claimable", claimed === 1);
	check("the same click is not claimable twice", controller.claimClicks() === 0);

	await controller.stop();
	await sleep(1500);

	const after = readJson(petInfo);
	check("pet recorded its exit", after === null || after.alive === false);

	console.log(`\n${failures === 0 ? "E2E PASSED" : `${failures} E2E CHECK(S) FAILED`}`);
	process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((error) => {
	console.error("e2e crashed:", error);
	process.exitCode = 1;
});
