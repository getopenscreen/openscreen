// CLI export benchmark: wall time, output frames/fps, CPU seconds and peak memory of the process tree.
// node export-bench.mjs <scratch> <reps>   — runs interleaved v200/main for each case.
import { execFile, execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

process.on("uncaughtException", (e) => {
	console.error(e);
	process.exit(1);
});

const [scratch, repsArg] = process.argv.slice(2);
const reps = Number(repsArg ?? 3);
const HERE = path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, "$1");
const project = fs
	.readdirSync(path.join(scratch, "projects"))
	.map((f) => path.join(scratch, "projects", f))
	.sort((x, y) => fs.statSync(y).size - fs.statSync(x).size)[0]; // heavy
const outDir = path.join(scratch, "out", "export");
fs.mkdirSync(outDir, { recursive: true });

const cases = [
	{
		id: "mp4-1080p60",
		ext: "mp4",
		args: { v200: ["--quality", "good"], main: ["--quality", "good", "--fps", "60"] },
	},
	{ id: "mp4-1080p30", ext: "mp4", args: { main: ["--quality", "good", "--fps", "30"] } },
	{
		id: "gif-medium-15",
		ext: "gif",
		args: {
			v200: ["--format", "gif", "--gif-size", "medium", "--gif-fps", "15"],
			main: ["--format", "gif", "--gif-size", "medium", "--gif-fps", "15"],
		},
	},
];

// Asynchronous, so the export's exit event is timed when it happens, not after a sample.
const procsnap = (root) =>
	new Promise((resolve) =>
		execFile(
			"powershell",
			[
				"-NoProfile",
				"-ExecutionPolicy",
				"Bypass",
				"-File",
				path.join(HERE, "procsnap.ps1"),
				"-Root",
				root,
			],
			{ encoding: "utf8" },
			(error, out) => resolve(error ? [] : JSON.parse(out || "[]")),
		),
	);

const probe = (file) => {
	const j = JSON.parse(
		execFileSync(
			"ffprobe",
			[
				"-v",
				"error",
				"-count_packets",
				"-select_streams",
				"v:0",
				"-show_entries",
				"stream=nb_read_packets,avg_frame_rate,r_frame_rate,width,height,duration:format=duration,size",
				"-of",
				"json",
				file,
			],
			{ encoding: "utf8" },
		),
	);
	const s = j.streams[0];
	return {
		frames: Number(s.nb_read_packets),
		avgFps: s.avg_frame_rate,
		width: s.width,
		height: s.height,
		duration: Number(s.duration ?? j.format.duration),
		size: Number(j.format.size),
	};
};

async function runOne(ver, c, rep) {
	const app = path.join(scratch, `app-${ver}`);
	const out = path.join(outDir, `${c.id}-${ver}-r${rep}.${c.ext}`);
	fs.rmSync(out, { force: true });
	const t0 = performance.now();
	const p = spawn(
		path.join(app, "Openscreen.exe"),
		[
			`--user-data-dir=${path.join(scratch, "profiles", `export-${ver}`)}`,
			"export",
			project,
			"-o",
			out,
			...c.args[ver],
			"--json",
		],
		{ stdio: ["ignore", "pipe", "ignore"] },
	);
	let stdout = "";
	p.stdout.on("data", (b) => (stdout += b));
	const seen = new Map();
	let done = false;
	let exitedAt = 0;
	p.on("exit", () => {
		exitedAt = performance.now();
		done = true;
	});
	while (!done) {
		for (const s of await procsnap(app)) {
			const prev = seen.get(s.pid);
			seen.set(s.pid, {
				role: s.role,
				cpuSec: s.cpuSec,
				peakWs: Math.max(s.peakWs, prev?.peakWs ?? 0),
				priv: Math.max(s.priv, prev?.priv ?? 0),
			});
		}
		await new Promise((r) => setTimeout(r, 500));
	}
	const wallSec = (exitedAt - t0) / 1000;
	const last = stdout
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((l) => {
			try {
				return JSON.parse(l);
			} catch {
				return null;
			}
		})
		.filter(Boolean)
		.pop();
	const procs = [...seen.values()];
	const r = {
		case: c.id,
		ver,
		rep,
		wallSec,
		ok: last?.event === "done" && last.success === true,
		cpuSec: procs.reduce((s, x) => s + x.cpuSec, 0),
		cpuByRole: Object.fromEntries(
			Object.entries(Object.groupBy(procs, (x) => x.role)).map(([k, v]) => [
				k,
				v.reduce((s, x) => s + x.cpuSec, 0),
			]),
		),
		peakWsSum: procs.reduce((s, x) => s + x.peakWs, 0),
		maxPriv: Math.max(...procs.map((x) => x.priv)),
		output: fs.existsSync(out) ? probe(out) : null,
	};
	fs.appendFileSync(path.join(outDir, "results.ndjson"), `${JSON.stringify(r)}\n`);
	console.log(
		JSON.stringify({
			case: r.case,
			ver,
			rep,
			ok: r.ok,
			wallSec: r.wallSec.toFixed(1),
			cpuSec: r.cpuSec.toFixed(1),
			frames: r.output?.frames,
			dur: r.output?.duration,
		}),
	);
	if (c.ext === "mp4" && rep > 1) fs.rmSync(out, { force: true }); // keep one sample per case, C: is tight
}

// FROM_REP resumes a series; SKIP=case:ver,... leaves out cases already measured enough.
const fromRep = Number(process.env.FROM_REP ?? 0);
const skip = new Set((process.env.SKIP ?? "").split(",").filter(Boolean));
for (let rep = fromRep; rep <= reps; rep++) {
	// rep 0 = warm-up (shader caches, disk cache), discarded by the analysis
	for (const c of cases) {
		const vers = rep % 2 ? ["main", "v200"] : ["v200", "main"];
		for (const ver of vers)
			if (c.args[ver] && !skip.has(`${c.id}:${ver}`)) await runOne(ver, c, rep);
	}
}
