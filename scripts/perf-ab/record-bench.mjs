// One 60 s full-screen take with the webcam, driven over CDP on the HUD (synthetic clicks: this
// measures the recorder, not the HUD's reachability). A full-screen ffplay pattern changes at
// 120 fps, so every 60 fps recorded frame must advance the bar by two pattern frames.
//
// node record-bench.mjs --ver v200 --app <dir> --profile <dir> --out <dir> --run <n> [--sec 60]
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
		sec: { type: "string", default: "60" },
	},
});
const HERE = path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, "$1");
const tag = `record-${a.ver}-r${a.run}`;
fs.mkdirSync(a.out, { recursive: true });
const outFile = (s) => path.join(a.out, `${tag}${s}`);
const procsnap = () =>
	JSON.parse(
		execFileSync(
			"powershell",
			[
				"-NoProfile",
				"-ExecutionPolicy",
				"Bypass",
				"-File",
				path.join(HERE, "procsnap.ps1"),
				"-Root",
				a.app,
			],
			{ encoding: "utf8" },
		) || "[]",
	);
const until = async (fn, timeoutMs = 60000, everyMs = 50) => {
	const end = Date.now() + timeoutMs;
	while (Date.now() < end) {
		try {
			if (await fn()) return true;
		} catch {
			// not ready yet, or already gone: either way there is nothing to do
		}
		await sleep(everyMs);
	}
	throw new Error(`timeout: ${fn}`);
};

const recDir = path.join(a.profile, "recordings");
fs.mkdirSync(recDir, { recursive: true });
for (const f of fs.readdirSync(recDir))
	fs.rmSync(path.join(recDir, f), { recursive: true, force: true });
for (const f of ["projects"]) fs.rmSync(path.join(a.profile, f), { recursive: true, force: true });
// Same settings for both versions: webcam on at the default quality, no audio, no desktop-icon overlay.
const settingsPath = path.join(a.profile, "recording-settings.json");
const prev = fs.existsSync(settingsPath) ? JSON.parse(fs.readFileSync(settingsPath, "utf8")) : {};
fs.writeFileSync(
	settingsPath,
	JSON.stringify(
		{
			...prev,
			autoZoomEnabled: false,
			micEnabled: false,
			systemAudioEnabled: false,
			camEnabled: true,
			camDeviceId: "7a598dd6b8baca1cab5ad39e42935353f0a6bc3fa005060d4c193811631255fe",
			camDeviceName: "Logitech StreamCam (046d:0893)",
			camQuality: "2160p",
			cursorCaptureMode: "editable-overlay",
			hideDesktopIcons: false,
		},
		null,
		2,
	),
);

const result0 = {};
const pattern = spawn(
	"ffplay",
	[
		"-hide_banner",
		"-loglevel",
		"error",
		"-fs",
		"-an",
		"-f",
		"lavfi",
		"-i",
		"color=c=0x404040:s=1920x1080:r=120[a];color=c=white:s=24x1080:r=120[b];[a][b]overlay=x='mod(n*16,1904)':y=0[out0]",
	],
	{ stdio: "ignore" },
);
await sleep(2000);
// Opened by a background process, the pattern lands behind the foreground window: pin it, or the
// take films whatever else is on screen.
result0.patternTopmost = Number(
	execFileSync(
		"powershell",
		[
			"-NoProfile",
			"-ExecutionPolicy",
			"Bypass",
			"-File",
			path.join(HERE, "topmost.ps1"),
			"-ProcessId",
			String(pattern.pid),
		],
		{ encoding: "utf8" },
	).trim(),
);
if (!result0.patternTopmost) {
	execFileSync("taskkill", ["/T", "/F", "/PID", String(pattern.pid)], { stdio: "ignore" });
	throw new Error("pattern window not found");
}

const port = 9300 + Math.floor(Math.random() * 500);
const log = fs.openSync(outFile(".app.log"), "w");
const app = spawn(
	path.join(a.app, "Openscreen.exe"),
	[`--user-data-dir=${a.profile}`, `--remote-debugging-port=${port}`],
	{ stdio: ["ignore", log, log] },
);
const result = { tag, ver: a.ver, run: Number(a.run), ...result0 };
try {
	const hud = await connect(
		await waitTarget(port, (ts) => ts.find((t) => t.url.includes("hud-overlay"))),
	);
	await until(() =>
		hud.evaluate(`!!document.querySelector('[data-testid="launch-record-button"]')`),
	);
	await sleep(2000);
	result.camPressed = await hud.evaluate(
		`document.querySelector('[data-testid="launch-webcam-button"]').getAttribute('aria-pressed')`,
	);
	if (result.camPressed !== "true") {
		await hud.evaluate(
			`document.querySelector('[data-testid="launch-webcam-button"]').click(), true`,
		);
		await sleep(1500);
	}
	await hud.evaluate(
		`document.querySelector('[data-testid="launch-source-selector-button"]').click(), true`,
	);
	const sel = await connect(
		await waitTarget(port, (ts) => ts.find((t) => t.url.includes("source-selector"))),
	);
	await until(
		() =>
			sel.evaluate(
				`!!document.querySelector('[data-testid="source-selector-card"][data-source-kind="screen"]')`,
			),
		30000,
	);
	await sel.evaluate(
		`document.querySelector('[data-testid="source-selector-card"][data-source-kind="screen"]').click(), true`,
	);
	await sleep(500);
	await sel
		.evaluate(
			`document.querySelector('[data-testid="source-selector-share-button"]').click(), true`,
		)
		.catch(() => {
			// the picker closes on this click, so the evaluation may never answer
		});
	await sleep(1500);
	await hud.evaluate(
		`document.querySelector('[data-testid="launch-record-button"]').click(), true`,
	);
	await until(
		() => hud.evaluate(`!!document.querySelector('[data-testid="launch-pause-button"]')`),
		30000,
	);
	await sleep(2000); // countdown overlay, encoder warm-up
	const snap0 = procsnap();
	const w0 = performance.now();
	await sleep(Number(a.sec) * 1000);
	const snap1 = procsnap();
	result.cpu = { wallSec: (performance.now() - w0) / 1000, before: snap0, after: snap1 };
	await hud.evaluate(
		`document.querySelector('[data-testid="launch-record-button"]').click(), true`,
	);
	// Saving ends when the editor opens on the take.
	await waitTarget(port, (ts) => ts.find((t) => t.url.includes("windowType=editor")), 120000, 100);
	await sleep(3000);
	result.files = fs
		.readdirSync(recDir)
		.map((f) => ({ f, size: fs.statSync(path.join(recDir, f)).size }));
	result.ok = true;
} catch (e) {
	result.ok = false;
	result.error = String(e?.stack ?? e);
} finally {
	try {
		execFileSync("taskkill", ["/T", "/F", "/PID", String(app.pid)], { stdio: "ignore" });
	} catch {
		// not ready yet, or already gone: either way there is nothing to do
	}
	try {
		execFileSync("taskkill", ["/T", "/F", "/PID", String(pattern.pid)], { stdio: "ignore" });
	} catch {
		// not ready yet, or already gone: either way there is nothing to do
	}
	fs.writeFileSync(outFile(".json"), JSON.stringify(result));
	console.log(
		JSON.stringify({
			tag,
			ok: result.ok,
			error: result.error?.slice(0, 300),
			cam: result.camPressed,
			files: result.files,
		}),
	);
	process.exit(0);
}
