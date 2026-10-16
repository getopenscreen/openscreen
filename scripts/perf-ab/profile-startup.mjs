// CPU profile of the main process from its first line to HUD ready.
// node profile-startup.mjs --ver <label> --app <dir> --profile <dir> --out <dir> --run <n>
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
		out: { type: "string" },
		run: { type: "string", default: "0" },
	},
});
fs.mkdirSync(a.out, { recursive: true });
const tag = `prof-${a.ver}-r${a.run}`;
const port = 9400 + Math.floor(Math.random() * 500);
const inspect = port + 600;
const app = spawn(
	path.join(a.app, "Openscreen.exe"),
	[`--inspect-brk=${inspect}`, `--user-data-dir=${a.profile}`, `--remote-debugging-port=${port}`],
	{ stdio: "ignore" },
);
const kill = () => {
	try {
		execFileSync("taskkill", ["/T", "/F", "/PID", String(app.pid)], { stdio: "ignore" });
	} catch {
		// already gone
	}
};
try {
	let node = null;
	for (let i = 0; i < 400 && !node; i++) {
		try {
			node = (await (await fetch(`http://127.0.0.1:${inspect}/json/list`)).json())[0];
		} catch {
			await sleep(25);
		}
	}
	if (!node) throw new Error("no inspector");
	const main = await connect(node);
	await main.send("Profiler.enable");
	await main.send("Profiler.setSamplingInterval", { interval: 200 });
	await main.send("Profiler.start");
	const t0 = Date.now();
	await main.send("Runtime.runIfWaitingForDebugger");
	const hud = await connect(
		await waitTarget(port, (ts) => ts.find((t) => t.url.includes("hud-overlay")), 60000, 5),
	);
	const hudTargetAt = Date.now() - t0;
	let ready = false;
	for (let i = 0; i < 2000 && !ready; i++) {
		try {
			ready = await hud.evaluate(
				`!!document.querySelector('[data-testid="launch-record-button"]')`,
			);
		} catch {
			// document not there yet
		}
		if (!ready) await sleep(5);
	}
	// A timeout is not a startup time: write nothing the analysis would take for one.
	if (!ready) throw new Error("the HUD never became ready");
	const hudReadyAt = Date.now() - t0;
	await sleep(300);
	const { profile } = await main.send("Profiler.stop");
	fs.writeFileSync(path.join(a.out, `${tag}.cpuprofile`), JSON.stringify(profile));
	fs.writeFileSync(
		path.join(a.out, `${tag}.json`),
		JSON.stringify({ tag, ver: a.ver, hudTargetAt, hudReadyAt }),
	);
	console.log(JSON.stringify({ tag, hudTargetAt, hudReadyAt }));
} catch (e) {
	console.error(e);
	process.exitCode = 1;
} finally {
	kill();
	process.exit();
}
