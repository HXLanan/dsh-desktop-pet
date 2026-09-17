/**
 * Local harness for the dsh-desktop-pet host half.
 *
 * Exercises `apply()` against a stub cordis context so the plugin's process
 * management and API surface can be verified without restarting DSH. Run:
 *
 *     node tools/harness.mjs [--start] [--api] [--stop]
 *
 * With no flags it only checks module loading plus config resolution.
 */

import { apply, resolveConfig, runtimeDir } from "../lib/index.js";

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);

/** Minimal stand-in for the pieces of ctx the plugin actually touches. */
function makeStubContext({ withSubprocess }) {
	const routes = [];
	const effects = [];
	const logs = [];

	const ctx = {
		logger: {
			info: (m) => { logs.push(`INFO  ${m}`); console.log(`INFO  ${m}`); },
			warn: (m) => { logs.push(`WARN  ${m}`); console.log(`WARN  ${m}`); },
		},
		// The plugin reaches for subprocess through ctx.get(...).
		get(service) {
			if (service === "subprocess") {
				if (!withSubprocess) return undefined;
				return {
					spawn(spec) {
						console.log(`[stub] spawn: ${spec.argv.join(" ")}`);
						return {
							pid: -1,
							done: Promise.resolve({ exitCode: 0, signal: null }),
							terminate() {},
							async waitForExit() { return true; },
						};
					},
				};
			}
			return undefined;
		},
		webServer: {
			register(route) {
				routes.push(route);
				return () => {};
			},
		},
		webRuntime: { trustedHosts: [] },
		effect(fn, label) {
			effects.push({ fn, label });
			const disposer = fn();
			return disposer;
		},
	};

	return { ctx, routes, effects, logs };
}

/** Drive one API request through the registered route handler. */
async function callApi(routes, body, { method = "POST", contentType = "application/json" } = {}) {
	const route = routes.find((r) => r.path === "/desktop-pet/api");
	if (!route) throw new Error("route /desktop-pet/api was not registered");

	const listeners = {};
	const req = {
		method,
		headers: { host: "127.0.0.1:1234", "content-type": contentType },
		on(event, handler) { listeners[event] = handler; return this; },
		destroy() {},
	};
	const captured = { status: 0, body: "" };
	const res = {
		writeHead(status) { captured.status = status; return this; },
		end(chunk) { captured.body = chunk ?? ""; },
	};

	const pending = route.handler(req, res);
	// Feed the body after the handler has attached its listeners.
	await new Promise((resolve) => setTimeout(resolve, 0));
	if (listeners.data && body !== undefined) {
		listeners.data(Buffer.from(JSON.stringify(body), "utf8"));
	}
	if (listeners.end) listeners.end();
	await pending;
	return { status: captured.status, json: captured.body ? JSON.parse(captured.body) : null };
}

async function main() {
	let failures = 0;
	const check = (label, condition) => {
		console.log(`${condition ? "PASS" : "FAIL"}  ${label}`);
		if (!condition) failures += 1;
	};

	// -- configuration -----------------------------------------------------
	const config = resolveConfig({});
	console.log(`resolved python : ${config.pythonPath}`);
	console.log(`resolved pet dir: ${runtimeDir(config)}`);
	check("python path resolves to an executable-looking path", /python(\.exe)?$/i.test(config.pythonPath));
	check("scale defaults to 1.0", config.scale === 1.0);
	check("autoStart defaults to true", config.autoStart === true);

	// -- apply without the subprocess seam ---------------------------------
	const noSub = makeStubContext({ withSubprocess: false });
	apply(noSub.ctx, { autoStart: false, petDir: runtimeDir(config) });
	check("registers exactly one API route", noSub.routes.length === 1);
	check("route is the documented prefix", noSub.routes[0]?.path === "/desktop-pet/api");
	check("registers teardown effect", noSub.effects.length >= 1);

	// -- status ------------------------------------------------------------
	const status = await callApi(noSub.routes, { method: "status" });
	check("status answers 200", status.status === 200);
	check("status reports ok", status.json?.ok === true);
	check("status carries petDir", typeof status.json?.value?.petDir === "string");
	check("status exposes pendingClicks", typeof status.json?.value?.pendingClicks === "number");

	// -- click claim -------------------------------------------------------
	const firstClaim = await callApi(noSub.routes, { method: "clicks" });
	check("clicks answers 200", firstClaim.status === 200);
	check("clicks returns a count", typeof firstClaim.json?.value?.clicks === "number");
	const secondClaim = await callApi(noSub.routes, { method: "clicks" });
	check("a second claim returns 0 (read-and-advance)", secondClaim.json?.value?.clicks === 0);

	// -- trust fence -------------------------------------------------------
	const forbidden = await callApi(noSub.routes, { method: "status" });
	check("loopback host is accepted", forbidden.status === 200);

	// -- mood write --------------------------------------------------------
	const mood = await callApi(noSub.routes, { method: "mood", mood: "thinking" });
	check("mood write answers 200", mood.status === 200);
	check("mood write echoes the mood", mood.json?.value?.mood === "thinking");

	// -- bad input ---------------------------------------------------------
	const badMethod = await callApi(noSub.routes, undefined, { method: "GET" });
	check("GET is rejected with 405", badMethod.status === 405);
	const badCtype = await callApi(noSub.routes, { method: "status" }, { contentType: "text/plain" });
	check("non-JSON content type is rejected with 415", badCtype.status === 415);
	const unknown = await callApi(noSub.routes, { method: "nope" });
	check("unknown method answers 404", unknown.status === 404);

	// -- apply with the subprocess seam ------------------------------------
	if (has("--start") || has("--stop")) {
		const withSub = makeStubContext({ withSubprocess: true });
		apply(withSub.ctx, { autoStart: false, petDir: runtimeDir(config) });
		const started = await callApi(withSub.routes, { method: "start" });
		check("start answers 200", started.status === 200);
		if (has("--stop")) {
			const stopped = await callApi(withSub.routes, { method: "stop" });
			check("stop answers 200", stopped.status === 200);
		}
	}

	console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
	process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((error) => {
	console.error("harness crashed:", error);
	process.exitCode = 1;
});
