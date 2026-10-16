// Per-run metrics from gui-bench results, then median [min-max] per (scenario, version, hz).
// node summarize-gui.mjs <dir> [<dir> ...]  -> writes <first dir>/summary.json, prints per-run lines
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const HERE = path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, "$1");
const dirs = process.argv.slice(2);
const q = (arr, p) => {
	if (!arr.length) return null;
	const s = [...arr].sort((x, y) => x - y);
	return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const median = (a) => {
	const s = [...a].sort((x, y) => x - y);
	const h = s.length >> 1;
	return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
};
const diffs = (a) => a.slice(1).map((v, i) => v - a[i]);

function readCsv(file) {
	if (!fs.existsSync(file)) return null;
	const lines = fs
		.readFileSync(file, "utf8")
		.trim()
		.split(/\r?\n/)
		.map((l) => l.split('","').map((c) => c.replace(/^"|"$/g, "")));
	return { header: lines[0], rows: lines.slice(1) };
}

function gpuByRole(file, roleOf) {
	const csv = readCsv(file);
	if (!csv) return null;
	const acc = {};
	csv.header.forEach((h, i) => {
		const m = h.match(/pid_(\d+)_.*engtype_([A-Za-z0-9 ]+)\)/);
		if (!m || !roleOf.has(Number(m[1]))) return;
		const vals = csv.rows
			.slice(1)
			.map((r) => Number(r[i]))
			.filter((v) => Number.isFinite(v));
		if (!vals.length) return;
		const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
		const key = `${roleOf.get(Number(m[1]))}:${m[2]}`;
		acc[key] = (acc[key] ?? 0) + mean;
	});
	return acc;
}

function gpuMem(file, roleOf) {
	const csv = readCsv(file);
	if (!csv) return null;
	const out = { dedicatedMB: 0, sharedMB: 0, dedicatedMainMB: 0, dedicatedGpuProcMB: 0 };
	csv.header.forEach((h, i) => {
		const m = h.match(/pid_(\d+)_/);
		if (!m || !roleOf.has(Number(m[1]))) return;
		const v = Number(csv.rows.at(-1)[i]) / 2 ** 20;
		if (!Number.isFinite(v)) return;
		if (h.endsWith("Dedicated Usage")) {
			out.dedicatedMB += v;
			if (roleOf.get(Number(m[1])) === "main") out.dedicatedMainMB += v;
			if (roleOf.get(Number(m[1])) === "gpu-process") out.dedicatedGpuProcMB += v;
		} else if (h.endsWith("Shared Usage")) out.sharedMB += v;
	});
	return out;
}

function perRun(file) {
	const r = JSON.parse(fs.readFileSync(file, "utf8"));
	if (!r.ok) return { tag: r.tag, ok: false, error: r.error };
	const m = { tag: r.tag, scenario: r.scenario, ver: r.ver, hz: r.hz, run: r.run, ok: true };
	m.startupToHudMs = r.startupToHudMs;
	m.editorOpenMs = r.editorOpenToFirstFrameMs;
	const raf = diffs(r.probe.raf);
	const vsync = q(raf, 50);
	m.rafP50 = vsync;
	m.rafP95 = q(raf, 95);
	m.rafP99 = q(raf, 99);
	m.rafMax = Math.max(...raf);
	m.rafOverBudgetPct = (100 * raf.filter((x) => x > 1.5 * vsync).length) / raf.length;
	m.rafOver25 = raf.filter((x) => x > 25).length;
	const dr = diffs(r.probe.draw);
	m.paintFps = ((r.probe.draw.length - 1) * 1000) / (r.probe.draw.at(-1) - r.probe.draw[0]);
	m.paintP50 = q(dr, 50);
	m.paintP95 = q(dr, 95);
	m.paintP99 = q(dr, 99);
	m.paintMax = Math.max(...dr);
	m.paintOver25 = dr.filter((x) => x > 25).length;
	m.paintOver34 = dr.filter((x) => x > 34).length;
	m.transport =
		r.probe.shared > 0 && r.probe.readback === 0
			? "shared"
			: r.probe.readback > 0 && r.probe.shared === 0
				? "readback"
				: "mixed";
	m.longTasks = r.probe.lt.length;
	m.longTaskMs = r.probe.lt.reduce((s, [, d]) => s + d, 0);
	const before = new Map(r.cpu.before.map((p) => [p.pid, p]));
	const roleOf = new Map(r.cpu.after.map((p) => [p.pid, p.role]));
	const cpu = {};
	for (const p of r.cpu.after) {
		const d = p.cpuSec - (before.get(p.pid)?.cpuSec ?? 0);
		const role = p.role.startsWith("utility") ? "utility" : p.role;
		cpu[role] = (cpu[role] ?? 0) + (100 * d) / r.cpu.wallSec;
	}
	m.cpuTotal = Object.values(cpu).reduce((s, v) => s + v, 0);
	m.cpuMain = cpu.main ?? 0;
	m.cpuGpuProc = cpu["gpu-process"] ?? 0;
	m.cpuRenderer = cpu.renderer ?? 0;
	m.cpuOther = m.cpuTotal - m.cpuMain - m.cpuGpuProc - m.cpuRenderer;
	const base = file.replace(/\.json$/, "");
	const gpu = gpuByRole(`${base}.gpu.csv`, roleOf);
	if (gpu) {
		const sum = (pred) =>
			Object.entries(gpu)
				.filter(([k]) => pred(k))
				.reduce((s, [, v]) => s + v, 0);
		m.gpu3dMain = sum((k) => k === "main:3D");
		m.gpu3dGpuProc = sum((k) => k === "gpu-process:3D");
		m.gpuVideoDecode = sum((k) => k.endsWith(":VideoDecode"));
		m.gpuCopy = sum((k) => k.endsWith(":Copy"));
		m.gpuAll = sum(() => true);
	}
	if (r.memory) {
		const mem = r.memory;
		m.memWsMB = mem.reduce((s, p) => s + p.ws, 0) / 2 ** 20;
		m.memPrivMB = mem.reduce((s, p) => s + p.priv, 0) / 2 ** 20;
		m.memMainPrivMB =
			mem.filter((p) => p.role === "main").reduce((s, p) => s + p.priv, 0) / 2 ** 20;
		m.memRendererPrivMB =
			mem.filter((p) => p.role === "renderer").reduce((s, p) => s + p.priv, 0) / 2 ** 20;
		m.memGpuProcPrivMB =
			mem.filter((p) => p.role === "gpu-process").reduce((s, p) => s + p.priv, 0) / 2 ** 20;
		m.jsHeapMB = r.jsHeap ? r.jsHeap.used / 2 ** 20 : null;
		const gm = gpuMem(`${base}.gpumem.csv`, new Map(mem.map((p) => [p.pid, p.role])));
		if (gm) {
			m.gpuDedicatedMB = gm.dedicatedMB;
			m.gpuDedicatedMainMB = gm.dedicatedMainMB;
			m.gpuDedicatedGpuProcMB = gm.dedicatedGpuProcMB;
			m.gpuSharedMB = gm.sharedMB;
		}
	}
	const cap = `${base}.cap.mkv`;
	if (fs.existsSync(cap)) {
		const cached = `${base}.cap.json`;
		if (!fs.existsSync(cached))
			fs.writeFileSync(
				cached,
				execFileSync("python", [path.join(HERE, "analyze_capture.py"), cap, "18"], {
					encoding: "utf8",
					maxBuffer: 1 << 26,
				}),
			);
		const c = JSON.parse(fs.readFileSync(cached, "utf8"));
		m.screenUpdateHz = c.updateHz;
		m.screenUpdP50 = c.updateIntervalMs.p50;
		m.screenUpdP95 = c.updateIntervalMs.p95;
		m.screenUpdP99 = c.updateIntervalMs.p99;
		m.screenUpdOver25 = c.updateIntervalMs.over25ms;
		const spu = c.screenFramesPerUpdate;
		const total = Object.values(spu).reduce((s, v) => s + v, 0);
		m.screenSkipPct =
			(100 *
				Object.entries(spu)
					.filter(([k]) => Number(k) >= 2)
					.reduce((s, [, v]) => s + v, 0)) /
			total;
		m.screenRepeatPct = (100 * (spu["0"] ?? 0)) / total;
		m.cursorRmsPx = c.cursorResidualSourcePx.rms;
		m.cursorP99Px = c.cursorResidualSourcePx.p99;
		m.cursorBackward = c.cursorBackwardSteps;
	}
	return m;
}

const runs = dirs.flatMap((d) =>
	fs
		.readdirSync(d)
		.filter((f) => /^(light|heavy)-.*\.json$/.test(f) && !f.endsWith(".cap.json"))
		.map((f) => perRun(path.join(d, f))),
);
for (const r of runs) console.log(JSON.stringify(r));
const groups = Object.groupBy(
	runs.filter((r) => r.ok),
	(r) => `${r.scenario}|${r.hz}|${r.ver}`,
);
const agg = {};
for (const [k, rs] of Object.entries(groups)) {
	agg[k] = { n: rs.length };
	for (const key of Object.keys(rs[0])) {
		const vals = rs.map((r) => r[key]).filter((v) => typeof v === "number" && Number.isFinite(v));
		// Memory is only read on the sessions that played 2 min, so a metric may cover fewer runs.
		if (vals.length < 2 || ["run"].includes(key)) continue;
		agg[k][key] = {
			med: median(vals),
			min: Math.min(...vals),
			max: Math.max(...vals),
			n: vals.length,
			vals,
		};
	}
}
fs.writeFileSync(path.join(dirs[0], "summary.json"), JSON.stringify({ runs, agg }, null, 1));
console.log(JSON.stringify(Object.keys(agg)));
