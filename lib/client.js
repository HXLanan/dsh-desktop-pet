// dsh-desktop-pet — browser half (client plugin bundle).
//
// Loaded by dsh-client-modules at /plugins/dsh-desktop-pet/client.js and run
// through the vendored cordis Loader's lazy-CJS module table
// (window.__ModuleLoader__.load), the same shape the shipped ui-* bundles use.
//
// Design note: this half deliberately requires NO host modules. Every other
// plugin in the ecosystem pulls React, the store factory, and locale bundles
// from the shell's frozen module table, which couples it to one host
// generation's seed names. The pet only needs to observe the document and call
// its own host route, so staying dependency-free keeps this half loadable on
// any generation — a failure here would otherwise take the whole plugin (and
// the pet) down with it.
//
// What it does:
//   1. Watches the conversation surface for activity and maps it to a mood.
//   2. Pushes that mood to the host half at POST /desktop-pet/api.
//   3. Exposes window.dshDesktopPet for manual control from the console.

(() => {
	"use strict";

	if (typeof window === "undefined" || typeof window.__ModuleLoader__ !== "object" || window.__ModuleLoader__ === null) {
		return;
	}

	window.__ModuleLoader__.load({
		id: "dsh-desktop-pet",
		factory: (require) => {
			const module = { exports: {} };
			const exports = module.exports;
			Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

			/** Route owned by the host half. */
			const API_PATH = "/desktop-pet/api";
			/** localStorage key holding the user's on/off choice. */
			const ENABLED_KEY = "dsh-desktop-pet:enabled";
			/** Minimum gap between two mood pushes for the same mood. */
			const DEDUPE_MS = 1200;
			/** How long a transient "happy" reaction stays up. */
			const HAPPY_MS = 2200;
			/**
			 * How long after the last observed growth a turn still counts as
			 * running. Longer than the 1s poll so a pause between two tool
			 * calls does not flap the mood to idle and back.
			 */
			const STREAM_IDLE_MS = 2500;
			/**
			 * Consecutive no-growth polls required before a turn counts as
			 * finished. Small page churn (a ticking timer, a caret blink) keeps
			 * nudging the fingerprint, so exiting on the first quiet poll would
			 * flap the pet between working and idle every couple of seconds.
			 */
			const STREAM_QUIET_POLLS = 3;
			/**
			 * Fingerprint growth (in characters) below which a poll counts as
			 * noise rather than output.
			 *
			 * A live shell always churns a few characters per poll — a timer
			 * counting, a caret blinking, a relative timestamp re-rendering.
			 * Treating that as "the model is writing" is what made the pet
			 * flap between thinking and idle; a real token of output is far
			 * larger than this margin.
			 */
			const STREAM_NOISE_CHARS = 24;

			// ── state ────────────────────────────────────────────────────────

			let enabled = true;
			try {
				const stored = window.localStorage.getItem(ENABLED_KEY);
				if (stored === "0") enabled = false;
			} catch {
				// A blocked localStorage must not disable the pet outright.
			}

			let currentMood = "idle";
			let lastPushAt = 0;
			let lastPushedMood = null;
			let happyTimer = null;
			let observer = null;
			let pollTimer = null;

			// ── transport ────────────────────────────────────────────────────

			/** POST one method to the host half; never throws. */
			function callHost(method, extra) {
				const body = Object.assign({ method }, extra || {});
				return window
					.fetch(API_PATH, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify(body),
					})
					.then((response) => (response.ok ? response.json() : null))
					.catch(() => null);
			}

			/** Push a mood, collapsing repeats so the pet is not spammed. */
			function pushMood(mood, force) {
				if (!enabled) return;
				const now = Date.now();
				if (!force && mood === lastPushedMood && now - lastPushAt < DEDUPE_MS) return;
				lastPushedMood = mood;
				lastPushAt = now;
				currentMood = mood;
				void callHost("mood", { mood });
			}

			/** Show a short-lived celebration, then fall back to the base mood. */
			function celebrate() {
				// Never celebrate over an attention state: if the pet is
				// showing "I need you", a click must not paper over it.
				if (isAttentionMood(currentMood) || isAttentionMood(baseMood())) return;
				pushMood("happy", true);
				if (happyTimer !== null) window.clearTimeout(happyTimer);
				happyTimer = window.setTimeout(() => {
					happyTimer = null;
					pushMood(baseMood(), true);
				}, HAPPY_MS);
			}

			// ── activity sensing ─────────────────────────────────────────────

			/**
			 * A cheap, structure-independent fingerprint of the conversation.
			 *
			 * `textContent` length over the conversation area is the one signal
			 * that survives DSH restyling: while a turn streams, this number
			 * keeps climbing; while the app is idle it is stable. Earlier
			 * revisions keyed off guessed attributes (`data-ds-tool`,
			 * `class*="toolCall"`, `role="alert"`) that the real shell does not
			 * render, which pinned the pet on one mood forever.
			 */
			function conversationFingerprint() {
				try {
					const root = document.querySelector("main") || document.body;
					if (root === null) return 0;
					return (root.textContent || "").length;
				} catch {
					return 0;
				}
			}

			/** Rolling samples used to tell "still growing" from "settled". */
			let lastFingerprint = -1;
			let lastGrowthAt = 0;
			/** Consecutive polls that saw no growth, used to damp the exit. */
			let quietPolls = 0;

			/**
			 * Whether the conversation has grown recently enough to count as an
			 * active turn.
			 *
			 * Two guards keep this from flapping. The time window absorbs a
			 * short pause inside one turn (a tool call waiting on I/O), and the
			 * quiet-poll count absorbs the tiny periodic changes a live page
			 * always produces — a ticking timer, a blinking caret, a progress
			 * spinner — which would otherwise read as "the model is working"
			 * every couple of seconds.
			 */
			function isActivelyStreaming() {
				if (Date.now() - lastGrowthAt >= STREAM_IDLE_MS) return false;
				return quietPolls < STREAM_QUIET_POLLS;
			}

			/**
			 * Classify what DSH is doing.
			 *
			 * Ordering is the whole design here, highest priority first:
			 *
			 *   1. approval — a permission dialog is waiting. The run cannot
			 *      continue until the user answers, so this outranks every
			 *      other state; reporting "working" while a modal waits would
			 *      be actively misleading.
			 *   2. question — the agent asked something and is likewise blocked.
			 *   3. error — something failed and is showing.
			 *   4. working / thinking — the turn is producing output.
			 *   5. idle.
			 *
			 * The first two are read from attributes that the shell's own
			 * bundles render (verified in their sources), not from guessed
			 * class names — see `hasApprovalSurface` / `hasQuestionSurface`.
			 */
			function baseMood() {
				try {
					if (hasApprovalSurface()) return "approval";
					if (hasQuestionSurface()) return "question";
					if (hasErrorSurface()) return "error";
				} catch {
					// A DOM probe must never break the pet.
				}
				if (isActivelyStreaming()) return lastSawTool ? "working" : "thinking";
				return "idle";
			}

			/**
			 * Whether a permission request is waiting for the user.
			 *
			 * `data-approval-key` is rendered by `ApprovalFlow` in
			 * `@deepseek-ai/dsh-client-ui-conversation`, which mounts only
			 * while a request is pending — so the attribute's presence is
			 * exactly "the agent is blocked on approval".
			 */
			function hasApprovalSurface() {
				return document.querySelector("[data-approval-key]") !== null;
			}

			/**
			 * Whether the agent is waiting on an answer.
			 *
			 * `data-question-key` comes from `QuestionComposer` in
			 * `@deepseek-ai/dsh-client-ui-user-questions`; like approvals, the
			 * composer only exists while a question is pending. The panel can
			 * be minimised, but a minimised composer still holds its key, and
			 * a question the user has tucked away is still a blocked run.
			 */
			function hasQuestionSurface() {
				return document.querySelector("[data-question-key]") !== null;
			}

			/**
			 * Whether an error is showing right now.
			 *
			 * Kept deliberately narrow: a generic alert role is used by
			 * ordinary notices in this shell, so matching it alone would make
			 * the pet report an error whenever any toast appears. Only
			 * explicit, error-named surfaces count.
			 */
			function hasErrorSurface() {
				return document.querySelector(
					'[data-ds-error], .ds-error, [class*="errorBar"], [class*="ErrorBar"]',
				) !== null;
			}

			/** Tracks whether a tool call has been seen during the current turn. */
			let lastSawTool = false;

			/**
			 * Sample the conversation and update the activity bookkeeping.
			 * Called by the poll loop, which owns the time base.
			 */
			function sampleActivity() {
				const now = Date.now();
				const fingerprint = conversationFingerprint();
				// The first sample only establishes a baseline. Without this
				// guard, going from "no sample yet" to any content would read
				// as growth and the pet would report a turn that never
				// happened.
				if (lastFingerprint < 0) {
					lastFingerprint = fingerprint;
					return;
				}
				if (fingerprint > lastFingerprint + STREAM_NOISE_CHARS) {
					// Growth means the model or a tool is producing output. A
					// decrease is a view switch or a cleared draft, not work,
					// so only growth resets the quiet counter. The noise margin
					// matters: a live page ticks a timer or blinks a caret,
					// nudging the fingerprint by a character or two forever.
					lastGrowthAt = now;
					lastSawTool = detectToolActivity();
					quietPolls = 0;
				} else if (fingerprint < lastFingerprint - STREAM_NOISE_CHARS) {
					// A real decrease is a view switch or a cleared draft; it
					// is not output either, so it counts as quiet.
					quietPolls += 1;
				} else {
					// Within the noise band: neither growth nor a real change.
					quietPolls += 1;
				}
				lastFingerprint = fingerprint;
			}

			/**
			 * Best-effort tool-call detection for the thinking/working split.
			 *
			 * Returns false when nothing matches, which degrades to `thinking`
			 * rather than inventing a state — an honest "the model is busy" is
			 * better than a wrong "a tool is running".
			 */
			function detectToolActivity() {
				try {
					return document.querySelector(
						'[data-ds-tool], [data-tool-call], [class*="toolCall"], [class*="tool-call"], [class*="ToolCall"]',
					) !== null;
				} catch {
					return false;
				}
			}

			/** Re-evaluate and push when the classified mood actually moved. */
			function evaluate() {
				if (!enabled) return;
				const next = baseMood();
				// An attention state interrupts a running celebration: missing
				// a permission prompt because the pet was busy being pleased
				// about the previous message would defeat the point.
				const urgent = isAttentionMood(next);
				if (happyTimer !== null) {
					if (!urgent) return; // otherwise let the celebration finish
					window.clearTimeout(happyTimer);
					happyTimer = null;
				}
				if (next !== currentMood) pushMood(next, urgent);
			}

			/** Whether a mood means "the agent needs the user right now". */
			function isAttentionMood(mood) {
				return mood === "approval" || mood === "question";
			}

			// ── click -> animation ───────────────────────────────────────────

			/**
			 * The poke reaction is played by the pet window itself, the instant
			 * it is clicked.
			 *
			 * It deliberately does NOT round-trip through this half. The pet
			 * polls state.json on an interval, so relaying the click here would
			 * add that whole interval of latency to something that must feel
			 * instant — and a click is local play, not an instruction to DSH.
			 * `dshDesktopPet.poke()` remains available for driving the reaction
			 * from the console or from a future settings row.
			 */

			// ── wiring ───────────────────────────────────────────────────────

			function start() {
				if (observer !== null) return;
				if (!document.body) return; // The shell has not mounted yet.

				// Coalesce bursts of DOM mutations into one evaluation per frame.
				let scheduled = false;
				const schedule = () => {
					if (scheduled) return;
					scheduled = true;
					window.requestAnimationFrame(() => {
						scheduled = false;
						evaluate();
					});
				};

				observer = new MutationObserver(schedule);
				observer.observe(document.body, { childList: true, subtree: true, characterData: true });

				// A safety net for state that changes without a mutation.
				// Sampling must run before evaluation: the mood is derived from
				// the growth observed between samples, so the order here is
				// what makes the "still streaming?" window meaningful.
				pollTimer = window.setInterval(() => {
					sampleActivity();
					evaluate();
				}, 600);
				sampleActivity();

				// Tell the host the pet should be up, then seed the mood.
				void callHost("start");
				pushMood(baseMood(), true);

				// A finished turn is the natural moment to celebrate.
				document.addEventListener("click", onDocumentClick, true);
			}

			/** Celebrate when the user sends a message (the send control click). */
			function onDocumentClick(event) {
				try {
					const target = event.target;
					if (!(target instanceof Element)) return;
					const button = target.closest("button");
					if (button === null) return;
					const label = `${button.getAttribute("aria-label") || ""} ${button.getAttribute("title") || ""}`.toLowerCase();
					if (label.includes("send")) celebrate();
				} catch {
					// Ignore malformed events.
				}
			}

			function stop() {
				if (observer !== null) {
					observer.disconnect();
					observer = null;
				}
				if (pollTimer !== null) {
					window.clearInterval(pollTimer);
					pollTimer = null;
				}
				document.removeEventListener("click", onDocumentClick, true);
			}

			/** Toggle the pet from the console or a settings row. */
			function setEnabled(next) {
				enabled = Boolean(next);
				try {
					window.localStorage.setItem(ENABLED_KEY, enabled ? "1" : "0");
				} catch {
					// Preference persistence is best-effort.
				}
				if (enabled) {
					start();
					void callHost("start");
				} else {
					stop();
					void callHost("stop");
				}
				return enabled;
			}

			// ── public handle ────────────────────────────────────────────────

			window.dshDesktopPet = {
				get enabled() {
					return enabled;
				},
				get mood() {
					return currentMood;
				},
				enable: () => setEnabled(true),
				disable: () => setEnabled(false),
				toggle: () => setEnabled(!enabled),
				setMood: (mood) => pushMood(String(mood), true),
				status: () => callHost("status"),
				start: () => callHost("start"),
				stop: () => callHost("stop"),
				poke: () => callHost("poke"),
				/**
				 * Internals exposed for automated tests. The classifier is the
				 * part most likely to drift from the real shell, so it must be
				 * testable without a browser: a harness drives these against a
				 * stub document and asserts the resulting mood.
				 */
				__internals: {
					baseMood,
					sampleActivity,
					evaluate,
					hasErrorSurface,
					hasApprovalSurface,
					hasQuestionSurface,
					isAttentionMood,
					detectToolActivity,
					conversationFingerprint,
					reset: () => {
						lastFingerprint = -1;
						lastGrowthAt = 0;
						quietPolls = 0;
						lastSawTool = false;
						currentMood = "idle";
						lastPushedMood = null;
						lastPushAt = 0;
					},
					constants: { STREAM_IDLE_MS, STREAM_QUIET_POLLS, STREAM_NOISE_CHARS, DEDUPE_MS, HAPPY_MS },
				},
			};

			/**
			 * Cordis plugin entry.
			 *
			 * The pet's sensing loop is wired here rather than at module scope so
			 * the host loader owns its lifetime: when this client plugin unloads
			 * (hot reload, plugin disabled), `ctx.effect`'s disposer tears the
			 * observers down instead of leaving them attached to the document.
			 */
			function apply(ctx) {
				const boot = () => {
					if (enabled) start();
				};

				if (document.readyState === "loading") {
					document.addEventListener("DOMContentLoaded", boot, { once: true });
				} else {
					boot();
				}

				const dispose = () => stop();
				if (ctx && typeof ctx.effect === "function") {
					ctx.effect(() => dispose, "dsh-desktop-pet: pet sensing loop");
				}
				return dispose;
			}

			exports.name = "dsh-desktop-pet";
			exports.apply = apply;
			module.exports.default = module.exports;
			return module.exports;
		},
	});
})();
