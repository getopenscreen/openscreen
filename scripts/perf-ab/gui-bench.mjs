// One measured GUI session of a packaged OpenScreen build, driven over CDP.
// Startup to HUD, editor open to first preview frame, then playback with rAF / preview-paint
// probes, CPU per process, GPU per process, optional desktop capture of the preview, and
// memory after a long playback.
//
// node gui-bench.mjs --ver v200 --app <dir> --profile <dir> --project <file> --scenario light|heavy
//                    --out <dir> --run <n> [--capture] [--play 30] [--total 0] [--memtrace]
// --total keeps playing to that many seconds and reads memory; --memtrace also samples GPU memory
// every 15 s on the way.
import { execFile, execFileSync, spawn } from "node:child_process";
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
		scenario: { type: "string" },
		out: { type: "string" },
		run: { type: "string", default: "0" },
		capture: { type: "boolean", default: false },
		play: { type: "string", default: "30" },
		total: { type: "string", default: "0" },
		hz: { type: "string", default: "" },
		memtrace: { type: "boolean", default: false },
	},
});
const HERE = path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, "$1");
const exe = path.join(a.app, "Openscreen.exe");
const tag = `${a.scenario}-${a.ver}-r${a.run}${a.hz ? `-${a.hz}hz` : ""}`;
fs.mkdirSync(a.out, { recursive: true });
const outFile = (s) => path.join(a.out, `${tag}${s}`);
const playSec = Number(a.play);
const totalSec = Number(a.total);

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

// Fresh profile state: exactly one project (the editor auto-opens the most recent), maximized editor.
const projDir = path.join(a.profile, "projects");
fs.mkdirSync(projDir, { recursive: true });
for (const f of fs.readdirSync(projDir))
	fs.rmSync(path.join(projDir, f), { recursive: true, force: true });
fs.copyFileSync(a.project, path.join(projDir, path.basename(a.project)));
fs.writeFileSync(
	path.join(a.profile, "editor-window.json"),
	JSON.stringify({ x: 0, y: 0, width: 1600, height: 900, maximized: true }),
);

const port = 9300 + Math.floor(Math.random() * 500);
const log = fs.openSync(outFile(".app.log"), "w");
const t0 = performance.now();
const app = spawn(exe, [`--user-data-dir=${a.profile}`, `--remote-debugging-port=${port}`], {
	stdio: ["ignore", log, log],
});
const since = () => performance.now() - t0;
const result = { tag, ver: a.ver, scenario: a.scenario, run: Number(a.run), hz: a.hz || null };

const until = async (fn, timeoutMs = 60000, everyMs = 10) => {
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

const kill = () => {
	try {
		execFileSync("taskkill", ["/T", "/F", "/PID", String(app.pid)], { stdio: "ignore" });
	} catch {
		// not ready yet, or already gone: either way there is nothing to do
	}
};

try {
	const hudT = await waitTarget(
		port,
		(ts) => ts.find((t) => t.url.includes("hud-overlay")),
		60000,
		10,
	);
	result.hudTargetMs = since();
	const hud = await connect(hudT);
	await until(() =>
		hud.evaluate(`!!document.querySelector('[data-testid="launch-record-button"]')`),
	);
	result.startupToHudMs = since();
	await sleep(1500);

	const tOpen = performance.now();
	await hud.evaluate("void window.electronAPI.switchToEditor(), true").catch(() => {
		// the HUD closes as the editor opens, so this evaluation may never answer
	});
	const edT = await waitTarget(
		port,
		(ts) => ts.find((t) => t.url.includes("windowType=editor")),
		60000,
		10,
	);
	const ed = await connect(edT);
	await ed.evaluate(fs.readFileSync(path.join(HERE, "probe.js"), "utf8"));
	await until(() => ed.evaluate("!!document.querySelector('canvas[data-painted]')"), 90000, 5);
	result.editorOpenToFirstFrameMs = performance.now() - tOpen;
	await until(
		() => ed.evaluate("[...document.querySelectorAll('video')].some(v => v.readyState >= 2)"),
		60000,
	);
	result.topmostWindows = Number(
		execFileSync(
			"powershell",
			[
				"-NoProfile",
				"-ExecutionPolicy",
				"Bypass",
				"-File",
				path.join(HERE, "topmost.ps1"),
				"-ProcessId",
				String(app.pid),
			],
			{ encoding: "utf8" },
		).trim(),
	);
	// Unpinned, another window may cover the editor and the capture would film that window.
	if (a.capture && !result.topmostWindows)
		throw new Error("no editor window could be pinned on top");
	await sleep(3000);
	// A window Windows minimized sits at -32000: wait for topmost.ps1's restore to land.
	for (let i = 0; i < 20 && (await ed.evaluate("screenX <= -30000")); i++) await sleep(250);

	result.videos = await ed.evaluate(
		"[...document.querySelectorAll('video')].map(v => ({paused: v.paused, t: v.currentTime, d: v.duration, w: v.videoWidth}))",
	);
	result.window =
		await ed.evaluate(`(() => { const c = document.querySelector('canvas[data-painted]'); const r = c.getBoundingClientRect();
		return { dpr: devicePixelRatio, screenX, screenY, outerWidth, outerHeight, innerWidth, innerHeight, canvas: { left: r.left, top: r.top, width: r.width, height: r.height, bw: c.width, bh: c.height } }; })()`);

	// GPU engines per process for the playback window (typeperf resolves its wildcard at start, so it
	// starts once every process of the session exists).
	const gpuCsv = outFile(".gpu.csv");
	const gpu = spawn(
		"typeperf",
		[
			"\\GPU Engine(*)\\Utilization Percentage",
			"-si",
			"1",
			"-sc",
			String(playSec + 2),
			"-o",
			gpuCsv,
			"-y",
		],
		{ stdio: "ignore" },
	);

	let capture = null;
	if (a.capture) {
		const w = result.window;
		const d = w.dpr;
		// Maximized windows overhang the screen by their resize border; the client area starts at
		// screenX + (outer - inner) / 2 horizontally, and at screenY + (outer - inner) - that border vertically.
		const border = (w.outerWidth - w.innerWidth) / 2;
		const x = Math.round((w.screenX + border + w.canvas.left) * d) & ~1;
		const y =
			Math.round((w.screenY + (w.outerHeight - w.innerHeight - border) + w.canvas.top) * d) & ~1;
		const cw = Math.round(w.canvas.width * d) & ~1;
		const ch = Math.round(w.canvas.height * d) & ~1;
		result.captureRect = { x, y, w: cw, h: ch };
		capture = spawn(
			"ffmpeg",
			[
				"-hide_banner",
				"-loglevel",
				"error",
				"-y",
				"-f",
				"lavfi",
				"-i",
				`ddagrab=output_idx=0:framerate=560:draw_mouse=0:offset_x=${x}:offset_y=${y}:video_size=${cw}x${ch}`,
				"-t",
				String(playSec + 1),
				"-c:v",
				"h264_nvenc",
				"-preset",
				"p2",
				"-tune",
				"ll",
				"-rc",
				"constqp",
				"-qp",
				"14",
				"-fps_mode",
				"passthrough",
				"-enc_time_base",
				"1:10000",
				outFile(".cap.mkv"),
			],
			{ stdio: ["ignore", "ignore", "pipe"] },
		);
		capture.stderr.on("data", (b) => fs.appendFileSync(outFile(".cap.err"), b));
		await sleep(700);
	}

	await sleep(1500);
	const snap0 = procsnap();
	const w0 = performance.now();
	await ed.evaluate("window.__bench.start(), true");
	const clock0 = await ed.evaluate(
		"[performance.now(), document.querySelector('video').currentTime]",
	);
	await ed.key(" ", "Space", 32);
	await sleep(300);
	result.playingAfterKey = await ed.evaluate(
		"[...document.querySelectorAll('video')].some(v => !v.paused)",
	);
	if (!result.playingAfterKey)
		await ed.evaluate("document.querySelector('video').play().then(() => true)");
	await sleep(playSec * 1000 - 300);
	const probe = await ed.evaluate("window.__bench.stop()");
	result.visibility = await ed.evaluate("document.visibilityState");
	result.clock = {
		start: clock0,
		end: await ed.evaluate("[performance.now(), document.querySelector('video').currentTime]"),
	};
	const snap1 = procsnap();
	const w1 = performance.now();
	result.playWindowMs = w1 - w0;
	result.probe = probe;
	result.cpu = { wallSec: (w1 - w0) / 1000, before: snap0, after: snap1 };
	await new Promise((r) => (gpu.exitCode !== null ? r() : gpu.on("exit", r)));
	if (capture) await new Promise((r) => (capture.exitCode !== null ? r() : capture.on("exit", r)));

	if (totalSec > 0) {
		// Keep playing (looping at the end) until totalSec of playback, then read memory.
		const endAt = w0 + totalSec * 1000;
		let nextTrace = 0;
		result.gpuMemTrace = [];
		while (performance.now() < endAt) {
			if (a.memtrace && performance.now() >= nextTrace) {
				nextTrace = performance.now() + 15000;
				const t = Math.round((performance.now() - w0) / 1000);
				const file = outFile(`.gpumem-${t}.csv`);
				await new Promise((r) =>
					execFile(
						"typeperf",
						["\\GPU Process Memory(*)\\Dedicated Usage", "-sc", "1", "-o", file, "-y"],
						() => r(),
					),
				);
				result.gpuMemTrace.push({ t, file, pids: procsnap().map((p) => [p.pid, p.role]) });
			}
			const ended = await ed.evaluate(
				"(() => { const v = document.querySelector('video'); return v.paused && v.currentTime > v.duration - 0.5; })()",
			);
			if (ended) {
				await ed.evaluate("document.querySelector('video').currentTime = 0; true");
				await sleep(300);
				await ed.key(" ", "Space", 32);
			}
			await sleep(1000);
		}
		result.memory = procsnap();
		result.jsHeap = await ed.evaluate(
			"performance.memory ? { used: performance.memory.usedJSHeapSize, total: performance.memory.totalJSHeapSize } : null",
		);
		await new Promise((r) =>
			execFile(
				"typeperf",
				[
					"\\GPU Process Memory(*)\\Dedicated Usage",
					"\\GPU Process Memory(*)\\Shared Usage",
					"-sc",
					"1",
					"-o",
					outFile(".gpumem.csv"),
					"-y",
				],
				() => r(),
			),
		);
	}
	result.ok = true;
} catch (e) {
	result.ok = false;
	result.error = String(e?.stack ?? e);
} finally {
	kill();
	fs.writeFileSync(outFile(".json"), JSON.stringify(result));
	console.log(
		JSON.stringify({
			tag,
			ok: result.ok,
			error: result.error?.slice(0, 300),
			startupToHudMs: result.startupToHudMs,
			editorOpenToFirstFrameMs: result.editorOpenToFirstFrameMs,
			playing: result.playingAfterKey,
			draws: result.probe?.draw?.length,
			rafs: result.probe?.raf?.length,
		}),
	);
	process.exit(0);
}
