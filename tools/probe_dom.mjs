/**
 * Dump the real DSH DOM so the pet's state classifier can be written against
 * facts instead of guesses.
 *
 * Launches headless Chrome against the running harness, waits for the shell to
 * render, and reports the structural candidates a status probe could use:
 * buttons, aria attributes, and busy markers.
 *
 * Run:  node tools/probe_dom.mjs [url]
 */

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME_CANDIDATES = [
	"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
	"C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
	"C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
	"C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
];

const url = process.argv[2] || process.env.DSH_WEB_URL || "http://127.0.0.1:3080/";

function findBrowser() {
	for (const candidate of CHROME_CANDIDATES) {
		if (existsSync(candidate)) return candidate;
	}
	return null;
}

/** The probe runs inside the page and returns a plain JSON-able report. */
const PROBE = `(() => {
  const report = {
    title: document.title,
    url: location.href,
    counts: {},
    buttons: [],
    ariaBusy: [],
    alerts: [],
    textareas: [],
    editables: [],
    dataAttrs: [],
    classHints: [],
  };

  const all = document.querySelectorAll('*');
  report.counts.total = all.length;

  // Buttons with their identifying attributes.
  document.querySelectorAll('button').forEach((b) => {
    const label = (b.getAttribute('aria-label') || '').trim();
    const title = (b.getAttribute('title') || '').trim();
    const text = (b.textContent || '').trim().slice(0, 40);
    if (label || title || text) {
      report.buttons.push({ ariaLabel: label, title, text, disabled: b.disabled });
    }
  });

  // Anything advertising a busy state.
  document.querySelectorAll('[aria-busy]').forEach((el) => {
    report.ariaBusy.push({ tag: el.tagName, busy: el.getAttribute('aria-busy') });
  });

  // Anything that looks like an error/alert surface.
  document.querySelectorAll('[role="alert"], .ds-error, [data-ds-error]').forEach((el) => {
    report.alerts.push({ tag: el.tagName, role: el.getAttribute('role'), text: (el.textContent||'').trim().slice(0,60) });
  });

  document.querySelectorAll('textarea').forEach((t) => {
    report.textareas.push({ placeholder: t.placeholder || '', ariaLabel: t.getAttribute('aria-label') || '', disabled: t.disabled });
  });

  document.querySelectorAll('[contenteditable="true"], [contenteditable=""]').forEach((e) => {
    report.editables.push({ tag: e.tagName, cls: (e.className || '').toString().slice(0, 80) });
  });

  // Which data-* attributes actually appear? This is the key question: the
  // probe must know whether the attributes the current classifier guesses at
  // exist in the rendered DOM at all.
  const dataNames = new Set();
  all.forEach((el) => {
    for (const attr of el.attributes || []) {
      if (attr.name.startsWith('data-')) dataNames.add(attr.name);
    }
  });
  report.dataAttrs = Array.from(dataNames).sort().slice(0, 120);

  // Class-name stems that could indicate a tool call or streaming row.
  const classNames = new Set();
  all.forEach((el) => {
    const cls = (el.className || '').toString();
    if (cls) cls.split(/[ \\t\\n]+/).forEach((c) => { if (c) classNames.add(c); });
  });
  report.classHints = Array.from(classNames)
    .filter((c) => /tool|stream|busy|stop|loading|running|pending|thinking|reason/i.test(c))
    .sort()
    .slice(0, 80);
  report.classListSize = classNames.size;

  return report;
})()`;

async function main() {
	const browser = findBrowser();
	if (browser === null) {
		console.error("no Chrome/Edge found");
		process.exitCode = 1;
		return;
	}
	console.log(`browser: ${browser}`);
	console.log(`target : ${url}\n`);

	const profile = mkdtempSync(join(tmpdir(), "dsh-pet-probe-"));
	const outFile = join(profile, "dom.json");

	// --headless=new renders with the full engine; --dump-dom alone would not
	// wait for the SPA to mount, so we drive it with a tiny script instead.
	const script = `
		const fs = require('fs');
		${JSON.stringify(PROBE)}
	`;
	writeFileSync(join(profile, "probe.js"), script, "utf8");

	const child = spawn(browser, [
		"--headless=new",
		"--disable-gpu",
		"--no-first-run",
		"--no-default-browser-check",
		`--user-data-dir=${profile}`,
		"--virtual-time-budget=8000",
		"--dump-dom",
		url,
	], { stdio: ["ignore", "pipe", "pipe"] });

	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (chunk) => { stdout += chunk; });
	child.stderr.on("data", (chunk) => { stderr += chunk; });

	child.on("close", () => {
		console.log(`captured ${stdout.length} bytes of DOM`);
		// Report which of the selectors the current classifier relies on are
		// actually present — this is the fact the fix depends on.
		const checks = {
			"button[aria-label*=Stop]": /aria-label="[^"]*[Ss]top/.test(stdout),
			"button[title*=Stop]": /title="[^"]*[Ss]top/.test(stdout),
			"data-ds-tool": stdout.includes("data-ds-tool"),
			"data-ds-busy": stdout.includes("data-ds-busy"),
			"aria-busy": stdout.includes("aria-busy"),
			'role="alert"': stdout.includes('role="alert"'),
			"toolCall class": /toolCall/.test(stdout),
			"tool-call class": /tool-call/.test(stdout),
			textarea: stdout.includes("<textarea"),
			contenteditable: stdout.includes("contenteditable"),
		};
		console.log("\nselector presence in rendered DOM:");
		for (const [name, present] of Object.entries(checks)) {
			console.log(`  ${present ? "YES" : "no "}  ${name}`);
		}

		// Persist the raw DOM for follow-up inspection.
		const dumpPath = join(process.cwd(), "dom-dump.html");
		writeFileSync(dumpPath, stdout, "utf8");
		console.log(`\nraw DOM written to ${dumpPath}`);

		if (stderr.trim()) {
			console.log("\nstderr (truncated):");
			console.log(stderr.trim().split("\n").slice(0, 8).join("\n"));
		}

		try {
			rmSync(profile, { recursive: true, force: true });
		} catch {
			// Best effort.
		}
	});
}

main().catch((error) => {
	console.error("probe crashed:", error);
	process.exitCode = 1;
});
