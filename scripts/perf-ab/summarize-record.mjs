// CPU per process role during each take, and the recorded files' cadence, median [min-max] per version.
import fs from "node:fs";
import path from "node:path";

const dir = process.argv[2];
// The same median as summarize-gui.mjs and doc-tables.mjs: the two middle values averaged.
const q = (a) => {
	const s = [...a].sort((x, y) => x - y);
	const h = s.length >> 1;
	return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
};
const rows = {};
for (const f of fs.readdirSync(dir).filter((f) => /^record-.*-r\d+\.json$/.test(f))) {
	const r = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
	if (!r.ok) continue;
	const an = JSON.parse(
		fs.readFileSync(path.join(dir, f.replace(".json", ".analysis.json")), "utf8"),
	);
	const before = new Map(r.cpu.before.map((p) => [p.pid, p]));
	const cpu = {};
	for (const p of r.cpu.after) {
		const role = p.role.startsWith("utility") ? "utility" : p.role;
		cpu[role] =
			(cpu[role] ?? 0) + (100 * (p.cpuSec - (before.get(p.pid)?.cpuSec ?? 0))) / r.cpu.wallSec;
	}
	const m = {
		cpuTotal: Object.values(cpu).reduce((s, v) => s + v, 0),
		cpuWgc: cpu["wgc-capture.exe"] ?? 0,
		cpuCursor: cpu["cursor-sampler.exe"] ?? 0,
		cpuMain: cpu.main ?? 0,
		cpuRenderer: cpu.renderer ?? 0,
		cpuGpuProc: cpu["gpu-process"] ?? 0,
		screenFps: an.screen.fps,
		screenMaxGapMs: an.screen.maxGapMs,
		screenRepeated: an.screen.duplicated,
		camFps: an.webcam.fps,
		camMaxGapMs: an.webcam.maxGapMs,
		camIdentical: an.webcam.identicalConsecutive,
		roles: Object.keys(cpu).join(","),
	};
	console.log(
		f,
		JSON.stringify(
			Object.fromEntries(
				Object.entries(m).map(([k, v]) => [k, typeof v === "number" ? +v.toFixed(2) : v]),
			),
		),
	);
	if (!rows[r.ver]) rows[r.ver] = [];
	rows[r.ver].push(m);
}
const agg = {};
for (const [ver, ms] of Object.entries(rows)) {
	agg[`record|${ver}`] = {};
	for (const k of Object.keys(ms[0])) {
		const v = ms.map((m) => m[k]);
		if (typeof v[0] === "number")
			agg[`record|${ver}`][k] = { med: q(v), min: Math.min(...v), max: Math.max(...v) };
	}
}
fs.writeFileSync(path.join(dir, "summary.json"), JSON.stringify({ agg }, null, 1));
