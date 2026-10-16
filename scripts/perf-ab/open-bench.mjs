// Startup and editor open, split into phases. No playback: one session takes ~10 s.
// node open-bench.mjs --ver <label> --app <dir> --profile <dir> --project <file> --out <dir> --run <n>
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { connect, sleep, waitTarget } from "./cdp.mjs";

process.on("uncaughtException", (e) => {
	console.error(e);
	process.exit(1);
});
const { values: a } = parseArgs({
	options: {
		ver: { type: "string" },
		app: { type: "string" },
		profile: { type: "string" },
		project: { type: "string" },
		out: { type: "string" },
		run: { type: "string", default: "0" },
		nopin: { type: "boolean", default: false },
	},
});
const tag = `open-${a.ver}${a.nopin ? "-nopin" : ""}-r${a.run}`;
fs.mkdirSync(a.out, { recursive: true });
const projDir = path.join(a.profile, "projects");
fs.mkdirSync(projDir, { recursive: true });
for (const f of fs.readdirSync(projDir))
	fs.rmSync(path.join(projDir, f), { recursive: true, force: true });
fs.copyFileSync(a.project, path.join(projDir, path.basename(a.project)));
fs.writeFileSync(
	path.join(a.profile, "editor-window.json"),
	JSON.stringify({ x: 0, y: 0, width: 1600, height: 900, maximized: true }),
);

// Watches, from inside a page, the moments that matter; times are the page's performance.now().
const WATCH = `(() => {
	if (window.__open) return true;
	const o = (window.__open = {});
	const mark = (k, ok) => { if (o[k] === undefined && ok()) o[k] = performance.now(); };
	o.visibility = [[performance.now(), document.visibilityState]];
	document.addEventListener("visibilitychange", () => o.visibility.push([performance.now(), document.visibilityState]));
	const tick = () => {
		mark("root", () => document.querySelector("#root")?.childElementCount > 0);
		mark("hudButton", () => !!document.querySelector('[data-testid="launch-record-button"]'));
		mark("video", () => !!document.querySelector("video"));
		mark("videoMeta", () => [...document.querySelectorAll("video")].some((v) => v.readyState >= 1));
		mark("canvas", () => !!document.querySelector("canvas[data-painted]"));
		if (o.canvas === undefined || o.hudButton === undefined) setTimeout(tick, 1);
	};
	tick();
	return true;
})()`;
const pageTimes = (c) =>
	c.evaluate(`(() => { const n = performance.getEntriesByType("navigation")[0] || {};
		const lt = performance.getEntriesByType("longtask").map((e) => [Math.round(e.startTime), Math.round(e.duration)]);
		return { timeOrigin: performance.timeOrigin, dcl: n.domContentLoadedEventEnd, load: n.loadEventEnd, fcp: performance.getEntriesByName("first-contentful-paint")[0]?.startTime, marks: window.__open, lt,
			scripts: performance.getEntriesByType("resource").filter((r) => r.initiatorType === "script" || /\\.js$/.test(r.name)).map((r) => [r.name.split("/").pop(), Math.round(r.startTime), Math.round(r.duration), r.transferSize || r.decodedBodySize]) }; })()`);

const HERE = path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, "$1");
const exePath = path.resolve(a.app, "Openscreen.exe");
const pin = a.nopin
	? null
	: spawn(
			"powershell",
			[
				"-NoProfile",
				"-ExecutionPolicy",
				"Bypass",
				"-File",
				path.join(HERE, "pin-watch.ps1"),
				"-ExePath",
				exePath,
				"-Seconds",
				"40",
			],
			{ stdio: ["ignore", "pipe", "ignore"] },
		);
if (pin)
	await new Promise((ok) => pin.stdout.on("data", (b) => String(b).includes("ready") && ok()));
await sleep(500);
// 9333/9334 are a dev build's CDP and inspector ports on this machine: stay clear of them.
const port = 9400 + Math.floor(Math.random() * 500);
const log = fs.openSync(path.join(a.out, `${tag}.app.log`), "w");
const t0 = Date.now();
const app = spawn(
	path.join(a.app, "Openscreen.exe"),
	[`--user-data-dir=${a.profile}`, `--remote-debugging-port=${port}`],
	{ stdio: ["ignore", log, log] },
);
const r = { tag, ver: a.ver, run: Number(a.run), t0, pinned: !a.nopin };
const until = async (fn, ms = 60000) => {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		try {
			if (await fn()) return;
		} catch {
			// page not ready yet
		}
		await sleep(5);
	}
	throw new Error("timeout");
};
try {
	const hudT = await waitTarget(
		port,
		(ts) => ts.find((t) => t.url.includes("hud-overlay")),
		60000,
		5,
	);
	r.hudTargetAt = Date.now() - t0;
	const hud = await connect(hudT);
	// The target can exist before its document: install the watch for the next document too.
	await hud.send("Page.addScriptToEvaluateOnNewDocument", { source: WATCH });
	await hud.evaluate(WATCH);
	await until(() => hud.evaluate("window.__open.hudButton !== undefined"));
	r.hud = await pageTimes(hud);
	r.hudReadyAt = r.hud.timeOrigin + r.hud.marks.hudButton - t0;
	await sleep(1500);
	r.procsAtHud = Number(
		execFileSync(
			"powershell",
			[
				"-NoProfile",
				"-Command",
				`(Get-CimInstance Win32_Process | ? { $_.ExecutablePath -like '${a.app.replaceAll("/", "\\")}*' }).Count`,
			],
			{ encoding: "utf8" },
		).trim(),
	);
	r.switchAt = Date.now() - t0;
	await hud.evaluate("void window.electronAPI.switchToEditor(), true").catch(() => {
		// the HUD closes as the editor opens
	});
	const edT = await waitTarget(
		port,
		(ts) => ts.find((t) => t.url.includes("windowType=editor")),
		60000,
		5,
	);
	r.editorTargetAt = Date.now() - t0;
	const ed = await connect(edT);
	await ed.send("Page.addScriptToEvaluateOnNewDocument", { source: WATCH });
	await ed.evaluate(WATCH);
	await until(() => ed.evaluate("window.__open.canvas !== undefined"), 90000);
	r.editor = await pageTimes(ed);
	const at = (k) => r.editor.timeOrigin + r.editor.marks[k] - t0 - r.switchAt;
	r.phases = {
		windowToNavStart: r.editor.timeOrigin - t0 - r.switchAt,
		domContentLoaded: r.editor.dcl,
		rootRendered: r.editor.marks.root,
		videoElement: r.editor.marks.video,
		videoMetadata: r.editor.marks.videoMeta,
		firstFrame: r.editor.marks.canvas,
		total: at("canvas"),
	};
	r.ok = true;
} catch (e) {
	r.ok = false;
	r.error = String(e?.stack ?? e);
} finally {
	try {
		execFileSync("taskkill", ["/T", "/F", "/PID", String(app.pid)], { stdio: "ignore" });
		if (pin) execFileSync("taskkill", ["/T", "/F", "/PID", String(pin.pid)], { stdio: "ignore" });
	} catch {
		// already gone
	}
	fs.writeFileSync(path.join(a.out, `${tag}.json`), JSON.stringify(r));
	console.log(
		JSON.stringify({
			tag,
			ok: r.ok,
			err: r.error?.slice(0, 200),
			hudReady: Math.round(r.hudReadyAt),
			phases:
				r.phases &&
				Object.fromEntries(Object.entries(r.phases).map(([k, v]) => [k, Math.round(v)])),
		}),
	);
	process.exit(0);
}
