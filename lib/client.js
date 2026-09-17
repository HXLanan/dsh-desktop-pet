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
			let clickTimer = null;

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
				pushMood("happy", true);
				if (happyTimer !== null) window.clearTimeout(happyTimer);
				happyTimer = window.setTimeout(() => {
					happyTimer = null;
					pushMood(baseMood(), true);
				}, HAPPY_MS);
			}

			// ── activity sensing ─────────────────────────────────────────────

			/**
			 * Read the conversation surface and classify what DSH is doing.
			 *
			 * This intentionally reads only stable, structural hints — a
			 * streaming/stop control, a busy marker, error text — rather than
			 * depending on generated class names, which change between builds.
			 * When nothing matches, the pet simply idles.
			 */
			function baseMood() {
				try {
					if (document.querySelector('[data-ds-error], .ds-error, [role="alert"]')) {
						return "error";
					}
					// A visible stop control means a turn is streaming.
					const stop = document.querySelector(
						'button[aria-label*="Stop"], button[aria-label*="stop"], button[title*="Stop"]',
					);
					if (stop !== null) {
						// Distinguish "thinking" (waiting on the model) from
						// "working" (tools running) by the presence of tool rows.
						const toolish = document.querySelector(
							'[data-ds-tool], [class*="toolCall"], [class*="tool-call"]',
						);
						return toolish !== null ? "working" : "thinking";
					}
					if (document.querySelector('[data-ds-busy], [aria-busy="true"]')) return "thinking";
				} catch {
					// A DOM probe must never break the pet.
				}
				return "idle";
			}

			/** Re-evaluate and push when the classified mood actually moved. */
			function evaluate() {
				if (!enabled) return;
				if (happyTimer !== null) return; // let a celebration finish
				const next = baseMood();
				if (next !== currentMood) pushMood(next);
			}

			// ── click -> conversation ─────────────────────────────────────────

			/**
			 * Find the conversation composer in the current shell.
			 *
			 * Searched structurally (a textarea or contenteditable that is not
			 * our own UI) rather than by generated class name, so a DSH restyle
			 * does not silently break the "click the pet to talk" promise.
			 */
			function findComposer() {
				try {
					const editable = document.querySelectorAll(
						'textarea, [contenteditable="true"], [contenteditable=""]',
					);
					let fallback = null;
					for (const node of editable) {
						if (!(node instanceof HTMLElement)) continue;
						// Skip hidden nodes and anything the pet itself mounted.
						if (node.offsetParent === null && node.tagName !== "TEXTAREA") continue;
						if (node.closest("[data-dsh-desktop-pet]")) continue;
						if (node.tagName === "TEXTAREA") return node;
						if (fallback === null) fallback = node;
					}
					return fallback;
				} catch {
					return null;
				}
			}

			/**
			 * Bring DSH to the front and put the caret in the composer.
			 *
			 * A browser cannot raise an OS window on demand, so this does the
			 * part it can: focus the document, then the composer, which also
			 * makes the DSH window active on Windows.
			 */
			function focusConversation() {
				try {
					window.focus();
					const composer = findComposer();
					if (composer === null) return false;
					composer.focus();
					if (typeof composer.scrollIntoView === "function") {
						composer.scrollIntoView({ block: "nearest" });
					}
					return true;
				} catch {
					return false;
				}
			}

			/** Ask the host whether the pet was clicked, and react when it was. */
			function pollClicks() {
				if (!enabled) return;
				void callHost("clicks").then((response) => {
					const count = response && response.value ? response.value.clicks : 0;
					if (typeof count !== "number" || count <= 0) return;
					// The pet was clicked: treat it as "the user wants to type".
					celebrate();
					focusConversation();
				});
			}

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
				pollTimer = window.setInterval(evaluate, 1000);
				clickTimer = window.setInterval(pollClicks, 700);

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
				if (clickTimer !== null) {
					window.clearInterval(clickTimer);
					clickTimer = null;
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
				focusConversation: () => focusConversation(),
				pollClicks: () => pollClicks(),
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
