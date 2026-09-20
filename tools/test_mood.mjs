/**
 * Tests for the pet's DSH-state classifier.
 *
 * The classifier is the component most likely to drift from the real shell, so
 * it is exercised here against a stub document rather than trusted by eye. The
 * client bundle is loaded into a fake `window` with just the globals it uses.
 *
 * Run:  node tools/test_mood.mjs
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLIENT_PATH = join(HERE, "..", "lib", "client.js");

// ── a minimal DOM ──────────────────────────────────────────────────────────

/** One stubbed element: the classifier only reads textContent and matches. */
function makeElement(text = "") {
	return { textContent: text };
}

/**
 * Build a fake document whose `querySelector` answers from a rule table.
 *
 * Rules are [substringOfSelector, elementOrNull] pairs, consulted in order; the
 * first selector containing a rule's key decides. That is enough to drive every
 * branch of the classifier without a real DOM engine.
 */
function makeDocument(rules, bodyText = "") {
	const main = makeElement(bodyText);
	return {
		body: makeElement(bodyText),
		querySelector(selector) {
			for (const [key, value] of rules) {
				if (selector.includes(key)) return value;
			}
			return null;
		},
		querySelectorAll: () => [],
		readyState: "complete",
		addEventListener: () => {},
		removeEventListener: () => {},
	};
}

/** Load the client bundle against a prepared window and return its handle. */
function loadClient(document, { fetchImpl } = {}) {
	const store = new Map();
	const window = {
		document,
		location: { href: "http://127.0.0.1:3080/" },
		navigator: { language: "zh-CN" },
		localStorage: {
			getItem: (k) => (store.has(k) ? store.get(k) : null),
			setItem: (k, v) => store.set(k, v),
		},
		setInterval: () => 0,
		clearInterval: () => {},
		setTimeout: (fn) => 0,
		clearTimeout: () => {},
		requestAnimationFrame: (fn) => 0,
		fetch: fetchImpl || (() => Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) })),
		MutationObserver: class {
			observe() {}
			disconnect() {}
		},
		Element: class {},
		__ModuleLoader__: {
			load(registration) {
				registration.factory((name) => {
					throw new Error(`unexpected require(${name})`);
				});
			},
		},
	};
	window.window = window;

	const source = readFileSync(CLIENT_PATH, "utf8");
	// The bundle is an IIFE over `window`; run it with our stub as the global.
	const run = new Function("window", "document", "MutationObserver", "setInterval", "clearInterval", `${source}`);
	run(window, document, window.MutationObserver, window.setInterval, window.clearInterval);
	return window.dshDesktopPet;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let failures = 0;
function check(label, condition) {
	console.log(`${condition ? "PASS" : "FAIL"}  ${label}`);
	if (!condition) failures += 1;
}

async function main() {
	// ── idle when nothing is happening ─────────────────────────────────────
	{
		const doc = makeDocument([], "hello world");
		const pet = loadClient(doc);
		pet.__internals.reset();
		pet.__internals.sampleActivity();
		check("stable content classifies as idle", pet.__internals.baseMood() === "idle");
	}

	// ── growth means a turn is running ─────────────────────────────────────
	// The increments here are large on purpose: the classifier ignores tiny
	// churn as page noise, and a real token of model output is far larger.
	{
		const doc = makeDocument([], "hello");
		const pet = loadClient(doc);
		const internals = pet.__internals;
		const chunk = "x".repeat(200);
		internals.reset();
		internals.sampleActivity();          // baseline
		doc.body.textContent = "hello" + chunk;
		const mainElement = makeElement("hello" + chunk);
		doc.querySelector = (s) => (s.includes("main") ? mainElement : null);
		internals.sampleActivity();          // growth observed
		check("growing content classifies as thinking", internals.baseMood() === "thinking");
	}

	// ── growth with a tool row means working ───────────────────────────────
	{
		const toolRow = makeElement("running tool");
		const doc = makeDocument([["toolCall", toolRow]], "hello");
		const pet = loadClient(doc);
		const internals = pet.__internals;
		const chunk = "x".repeat(200);
		internals.reset();
		internals.sampleActivity();
		doc.body.textContent = "hello" + chunk;
		const mainElement = makeElement("hello" + chunk);
		doc.querySelector = (s) => (s.includes("main") ? mainElement : (s.includes("toolCall") ? toolRow : null));
		internals.sampleActivity();
		check("growth with a tool row classifies as working", internals.baseMood() === "working");
	}

	// ── streaming decays back to idle ──────────────────────────────────────
	{
		const doc = makeDocument([], "hello");
		const pet = loadClient(doc);
		const internals = pet.__internals;
		const chunk = "x".repeat(200);
		internals.reset();
		internals.sampleActivity();
		doc.body.textContent = "hello" + chunk;
		const mainElement = makeElement("hello" + chunk);
		doc.querySelector = (s) => (s.includes("main") ? mainElement : null);
		internals.sampleActivity();
		check("streaming first reads as thinking", internals.baseMood() === "thinking");
		await sleep(internals.constants.STREAM_IDLE_MS + 300);
		// The exit also requires a few consecutive quiet polls.
		for (let i = 0; i < internals.constants.STREAM_QUIET_POLLS; i += 1) internals.sampleActivity();
		check("after the idle window it settles back", internals.baseMood() === "idle");
	}

	// ── errors win over everything ─────────────────────────────────────────
	{
		const errorNode = makeElement("boom");
		const doc = makeDocument([["ds-error", errorNode]], "hello");
		const pet = loadClient(doc);
		check("an error surface classifies as error", pet.__internals.baseMood() === "error");
	}

	// ── a generic alert must NOT count as an error ─────────────────────────
	// This was the old bug: any toast made the pet report an error.
	{
		const doc = {
			body: makeElement("hello"),
			querySelector(selector) {
				// A generic alert exists, but no error-named surface does.
				if (selector.includes('role="alert"')) return makeElement("notice");
				return null;
			},
			querySelectorAll: () => [],
			readyState: "complete",
			addEventListener: () => {},
			removeEventListener: () => {},
		};
		const pet = loadClient(doc);
		pet.__internals.reset();
		pet.__internals.sampleActivity();
		check("a generic alert is not an error", pet.__internals.baseMood() === "idle");
	}

	// ── the historic bug: content stops growing but keeps a tool row ───────
	// The old classifier returned "working" forever whenever any tool row had
	// ever been rendered. Growth-based sensing must return to idle.
	{
		const toolRow = makeElement("old tool result");
		let text = "start";
		const mainElement = { get textContent() { return text; } };
		const doc = {
			body: mainElement,
			querySelector(selector) {
				if (selector.includes("main")) return mainElement;
				if (selector.includes("toolCall")) return toolRow; // always present
				return null;
			},
			querySelectorAll: () => [],
			readyState: "complete",
			addEventListener: () => {},
			removeEventListener: () => {},
		};
		const pet = loadClient(doc);
		const internals = pet.__internals;
		internals.reset();
		internals.sampleActivity();
		text = "start".padEnd(400, "x");
		internals.sampleActivity();
		check("during growth a lingering tool row reads as working", internals.baseMood() === "working");
		await sleep(internals.constants.STREAM_IDLE_MS + 300);
		for (let i = 0; i < internals.constants.STREAM_QUIET_POLLS; i += 1) internals.sampleActivity();
		check(
			"a finished turn stops reading as working (the reported bug)",
			internals.baseMood() === "idle",
		);
	}

	// ── a pending approval outranks everything ─────────────────────────────
	{
		const approval = makeElement("Allow this command?");
		const doc = makeDocument([["data-approval-key", approval]], "hello");
		const pet = loadClient(doc);
		pet.__internals.reset();
		check("a pending approval classifies as approval", pet.__internals.baseMood() === "approval");
	}

	// ── a pending question ─────────────────────────────────────────────────
	{
		const question = makeElement("Which file?");
		const doc = makeDocument([["data-question-key", question]], "hello");
		const pet = loadClient(doc);
		pet.__internals.reset();
		check("a pending question classifies as question", pet.__internals.baseMood() === "question");
	}

	// ── approval beats a question, an error, and active streaming ──────────
	{
		const approval = makeElement("Allow?");
		const question = makeElement("Which?");
		const error = makeElement("boom");
		const doc = {
			body: makeElement("hello"),
			querySelector(selector) {
				if (selector.includes("data-approval-key")) return approval;
				if (selector.includes("data-question-key")) return question;
				if (selector.includes("ds-error")) return error;
				return null;
			},
			querySelectorAll: () => [],
			readyState: "complete",
			addEventListener: () => {},
			removeEventListener: () => {},
		};
		const pet = loadClient(doc);
		check("approval outranks question, error, and streaming", pet.__internals.baseMood() === "approval");
	}

	// ── question beats an error ────────────────────────────────────────────
	{
		const question = makeElement("Which?");
		const error = makeElement("boom");
		const doc = {
			body: makeElement("hello"),
			querySelector(selector) {
				if (selector.includes("data-question-key")) return question;
				if (selector.includes("ds-error")) return error;
				return null;
			},
			querySelectorAll: () => [],
			readyState: "complete",
			addEventListener: () => {},
			removeEventListener: () => {},
		};
		const pet = loadClient(doc);
		pet.__internals.reset();
		check("question outranks error", pet.__internals.baseMood() === "question");
	}

	// ── the attention moods are recognised as urgent ───────────────────────
	{
		const doc = makeDocument([], "hello");
		const pet = loadClient(doc);
		const { isAttentionMood } = pet.__internals;
		check("approval is urgent", isAttentionMood("approval") === true);
		check("question is urgent", isAttentionMood("question") === true);
		check("working is not urgent", isAttentionMood("working") === false);
		check("idle is not urgent", isAttentionMood("idle") === false);
	}

	// ── an attention state interrupts a celebration ────────────────────────
	// A permission prompt must never be hidden behind a "happy" reaction.
	{
		let approvalPresent = false;
		const approval = makeElement("Allow?");
		const doc = {
			body: makeElement("hello"),
			querySelector(selector) {
				if (selector.includes("data-approval-key")) return approvalPresent ? approval : null;
				return null;
			},
			querySelectorAll: () => [],
			readyState: "complete",
			addEventListener: () => {},
			removeEventListener: () => {},
		};
		const pet = loadClient(doc);
		pet.__internals.reset();
		pet.setMood("happy");
		approvalPresent = true;
		pet.__internals.evaluate();
		check("an approval interrupts a celebration", pet.mood === "approval");
	}

	// ── small periodic page churn must not flap the mood ───────────────────
	// A live page always ticks something (a timer, a caret, a spinner). With a
	// naive "any growth = working" rule the pet flapped between thinking and
	// idle every couple of seconds, which read as agitation.
	{
		let text = "x".repeat(1000);
		const doc = {
			body: makeElement(""),
			querySelector(selector) {
				if (selector.includes("main")) {
					return { get textContent() { return text; } };
				}
				return null;
			},
			querySelectorAll: () => [],
			readyState: "complete",
			addEventListener: () => {},
			removeEventListener: () => {},
		};
		const pet = loadClient(doc);
		const internals = pet.__internals;
		internals.reset();
		internals.sampleActivity();          // baseline

		// One real burst of output, then nothing but churn.
		text = "x".repeat(1400);
		internals.sampleActivity();
		check("a burst of output reads as thinking", internals.baseMood() === "thinking");

		// Now mimic a ticking timer: the fingerprint jitters by a few chars
		// each poll without the conversation actually growing.
		let sawIdle = false;
		for (let i = 0; i < 20; i += 1) {
			text = "x".repeat(1400 + (i % 2) * 2);
			internals.sampleActivity();
			if (internals.baseMood() === "idle") sawIdle = true;
		}
		check(
			"the mood settles instead of flapping once output stops",
			sawIdle,
		);
	}

	console.log(`\n${failures === 0 ? "ALL MOOD CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
	process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((error) => {
	console.error("test crashed:", error);
	process.exitCode = 1;
});
