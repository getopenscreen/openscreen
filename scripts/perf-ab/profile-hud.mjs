// CPU profile of the HUD renderer from its first script to HUD ready: the browser target pauses
// every new page (waitForDebuggerOnStart), the profiler starts, then the page runs.
// node profile-hud.mjs --ver <label> --app <dir> --profile <dir> --out <dir> --run <n>
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { connect, sleep } from "./cdp.mjs";

process.on("uncaughtException", (e) => {
	console.error(e);
	process.exit(1);
});
const { values: a } = parseArgs({
	options: {
		ver: { type: "string" },
		app: { type: "string" },
		profile: { type: "string" },
		out: { type: "string" },
		run: { type: "string", default: "0" },
	},
});
fs.mkdirSync(a.out, { recursive: true });
const tag = `hud-${a.ver}-r${a.run}`;
const port = 9400 + Math.floor(Math.random() * 500);
const app = spawn(
	path.join(a.app, "Openscreen.exe"),
	[`--user-data-dir=${a.profile}`, `--remote-debugging-port=${port}`],
	{ stdio: "ignore" },
);
try {
	let ver = null;
	for (let i = 0; i < 2000 && !ver; i++) {
		try {
			ver = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
		} catch {
			await sleep(5);
		}
	}
	const browser = await connect({ webSocketDebuggerUrl: ver.webSocketDebuggerUrl });
	let resolveSession;
	const sessionReady = new Promise((r) => (resolveSession = r));
	browser.on((m) => {
		if (m.method === "Target.attachedToTarget" && m.params.targetInfo.url.includes("hud-overlay"))
			resolveSession(m.params.sessionId);
		else if (m.method === "Target.attachedToTarget")
			browser.send("Runtime.runIfWaitingForDebugger", {}, m.params.sessionId).catch(() => {
				// a target that went away needs no resume
			});
	});
	await browser.send("Target.setAutoAttach", {
		autoAttach: true,
		waitForDebuggerOnStart: true,
		flatten: true,
	});
	const sid = await sessionReady;
	await browser.send("Profiler.enable", {}, sid);
	await browser.send("Profiler.setSamplingInterval", { interval: 100 }, sid);
	await browser.send("Profiler.start", {}, sid);
	await browser.send("Runtime.runIfWaitingForDebugger", {}, sid);
	let ready = false;
	for (let i = 0; i < 2000 && !ready; i++) {
		try {
			const r = await browser.send(
				"Runtime.evaluate",
				{
					expression: `!!document.querySelector('[data-testid="launch-record-button"]')`,
					returnByValue: true,
				},
				sid,
			);
			ready = r.result.value === true;
		} catch {
			// no context yet
		}
		if (!ready) await sleep(5);
	}
	// A timeout is not a startup: write no profile the analysis would take for one.
	if (!ready) throw new Error("the HUD never became ready");
	const nav = (
		await browser.send(
			"Runtime.evaluate",
			{
				expression: "JSON.stringify(performance.getEntriesByType('navigation')[0])",
				returnByValue: true,
			},
			sid,
		)
	).result.value;
	const { profile } = await browser.send("Profiler.stop", {}, sid);
	fs.writeFileSync(path.join(a.out, `${tag}.cpuprofile`), JSON.stringify(profile));
	fs.writeFileSync(
		path.join(a.out, `${tag}.json`),
		JSON.stringify({ tag, ver: a.ver, nav: JSON.parse(nav) }),
	);
	console.log(
		JSON.stringify({ tag, ready, dcl: Math.round(JSON.parse(nav).domContentLoadedEventEnd) }),
	);
} catch (e) {
	console.error(e);
	process.exitCode = 1;
} finally {
	try {
		execFileSync("taskkill", ["/T", "/F", "/PID", String(app.pid)], { stdio: "ignore" });
	} catch {
		// already gone
	}
	process.exit();
}
