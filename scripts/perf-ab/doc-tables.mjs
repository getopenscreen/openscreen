// The curated tables of the results log, straight from the summaries (no hand copying).
import fs from "node:fs";
import { compareRows } from "./compare.mjs";

const [guiSummary, recordSummary, exportResults] = process.argv.slice(2);
const { agg } = JSON.parse(fs.readFileSync(guiSummary, "utf8"));
const head = "| Metric | 2.0.0 | main | Delta | Verdict |\n|---|---|---|---|---|";
const out = [];
const table = (title, a, group, rows) => {
	out.push(`#### ${title}\n\n${head}`);
	out.push(...compareRows(a, group, rows));
	out.push("");
};
table("Preview, light project (3 sessions each)", agg, "light|279", [
	["paintFps", "Preview paints per second", "higher"],
	["paintP95", "Paint interval p95 (ms)", "lower"],
	["paintP99", "Paint interval p99 (ms)", "lower"],
	["paintOver25", "Paints later than 25 ms, per 30 s", "lower", 0],
	["rafP99", "UI rAF interval p99 (ms)", "lower", 2],
	["rafOverBudgetPct", "UI rAF over 1.5 vsync (%)", "lower", 2],
	["cpuTotal", "CPU, all processes (% of one core)", "lower"],
	["cpuMain", "CPU, main process (%)", "lower"],
	["gpuAll", "GPU, all engines of the app (%)", "lower"],
	["screenUpdateHz", "On screen: preview updates per second", "higher"],
	["screenUpdP99", "On screen: update interval p99 (ms)", "lower"],
	["screenSkipPct", "On screen: updates skipping a video frame (%)", "lower", 2],
	["cursorRmsPx", "On screen: cursor off its path, RMS (source px)", "lower", 2],
	["cursorP99Px", "On screen: cursor off its path, p99 (source px)", "lower", 2],
	["cursorBackward", "On screen: cursor steps backwards", "lower", 0],
]);
table("Preview, heavy project (12 sessions each; memory on 3)", agg, "heavy|279", [
	["paintFps", "Preview paints per second", "higher"],
	["paintP95", "Paint interval p95 (ms)", "lower"],
	["paintP99", "Paint interval p99 (ms)", "lower"],
	["paintOver25", "Paints later than 25 ms, per 30 s", "lower", 0],
	["rafP99", "UI rAF interval p99 (ms)", "lower", 2],
	["longTasks", "Long tasks over 50 ms, per 30 s", "lower", 0],
	["cpuTotal", "CPU, all processes (% of one core)", "lower"],
	["cpuMain", "CPU, main process (%)", "lower"],
	["cpuGpuProc", "CPU, GPU process (%)", "lower"],
	["cpuRenderer", "CPU, renderer (%)", "lower"],
	["gpu3dMain", "GPU 3D, main process / compositor (%)", "lower"],
	["gpuVideoDecode", "GPU video decode (%)", "lower"],
	["gpuAll", "GPU, all engines of the app (%)", "lower"],
	["memPrivMB", "Private memory after 2 min (MB)", "lower", 0],
	["memMainPrivMB", "Private memory, main process (MB)", "lower", 0],
	["memRendererPrivMB", "Private memory, renderer (MB)", "lower", 0],
	["gpuDedicatedGpuProcMB", "GPU dedicated memory, GPU process, after 2 min (MB)", "lower", 0],
	["editorOpenMs", "Editor open to first preview frame (ms)", "lower", 0],
]);
// Startup is the same measurement in every session: pool light and heavy.
const pooled = {};
const runs = JSON.parse(fs.readFileSync(guiSummary, "utf8")).runs.filter((r) => r.ok);
for (const ver of ["v200", "main"]) {
	const v = runs
		.filter((r) => r.ver === ver)
		.map((r) => r.startupToHudMs)
		.sort((x, y) => x - y);
	const h = v.length >> 1;
	pooled[`startup|${ver}`] = {
		startupToHudMs: {
			med: v.length % 2 ? v[h] : (v[h - 1] + v[h]) / 2,
			min: v[0],
			max: v.at(-1),
			vals: v,
		},
	};
}
table("Startup (15 sessions each)", pooled, "startup", [
	["startupToHudMs", "Process start to HUD ready (ms)", "lower", 0],
]);
const rec = JSON.parse(fs.readFileSync(recordSummary, "utf8")).agg;
table("Recording, 60 s full screen with the webcam (3 takes each)", rec, "record", [
	["screenFps", "Screen video, frames per second", "info", 2],
	["screenMaxGapMs", "Screen video, longest gap between frames (ms)", "lower"],
	["screenRepeated", "Screen video, frames repeating the previous picture", "lower", 0],
	["camFps", "Webcam video, frames per second", "info", 2],
	["camMaxGapMs", "Webcam video, longest gap (ms)", "lower"],
	["camIdentical", "Webcam video, byte-identical consecutive frames", "lower", 0],
	["cpuWgc", "CPU, wgc-capture.exe (% of one core)", "lower"],
	["cpuMain", "CPU, main process (%)", "lower"],
	["cpuTotal", "CPU, all processes (%)", "lower"],
]);
const ex = fs
	.readFileSync(exportResults, "utf8")
	.trim()
	.split("\n")
	.map(JSON.parse)
	.filter((r) => r.ok);
const exAgg = {};
for (const c of ["mp4-1080p60", "mp4-1080p30", "gif-medium-15"]) {
	for (const ver of ["v200", "main"]) {
		let g = ex.filter((r) => r.case === c && r.ver === ver);
		const warm = g.filter((r) => r.rep > 0);
		if (warm.length >= 2) g = warm; // the warm-up run counts only where a case has too few others
		if (!g.length) continue;
		const stat = (vals) => {
			const s = [...vals].sort((x, y) => x - y);
			const h = s.length >> 1;
			return { med: s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2, min: s[0], max: s.at(-1) };
		};
		exAgg[`${c}|${ver}`] = {
			wallSec: stat(g.map((r) => r.wallSec)),
			frames: stat(g.map((r) => r.output.frames)),
			realtime: stat(g.map((r) => r.output.duration / r.wallSec)),
			n: g.length,
		};
	}
}
out.push(`#### Export, heavy project (60 s)\n\n${head}`);
for (const [c, label] of [
	["mp4-1080p60", "MP4 1080p 60 fps"],
	["mp4-1080p30", "MP4 1080p 30 fps"],
	["gif-medium-15", "GIF 720p 15 fps"],
]) {
	out.push(
		...compareRows(exAgg, c, [
			["wallSec", `${label}: wall time (s)`, "lower"],
			["frames", `${label}: frames written`, "info", 0],
			["realtime", `${label}: times real time`, "higher", 2],
		]),
	);
}
console.log(out.join("\n"));
