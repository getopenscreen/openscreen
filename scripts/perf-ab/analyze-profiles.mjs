// Self time per script and per function in main-process startup profiles, median over runs per build.
import fs from "node:fs";
import path from "node:path";

const dir = process.argv[2];
const med = (a) => {
	const s = [...a].sort((x, y) => x - y);
	const h = s.length >> 1;
	return s.length ? (s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2) : 0;
};
const byVer = {};
for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".cpuprofile"))) {
	const meta = JSON.parse(
		fs.readFileSync(path.join(dir, f.replace(".cpuprofile", ".json")), "utf8"),
	);
	const p = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
	const nodes = new Map(p.nodes.map((n) => [n.id, n]));
	const self = { file: {}, fn: {}, total: 0, idle: 0 };
	let t = 0;
	const limit = meta.hudTargetAt * 1000; // µs: main process until the HUD page exists
	for (let i = 0; i < p.samples.length; i++) {
		t += p.timeDeltas[i];
		if (t > limit) break;
		const n = nodes.get(p.samples[i]);
		const cf = n.callFrame;
		const dt = (p.timeDeltas[i + 1] ?? 0) / 1000;
		if (cf.functionName === "(idle)") {
			self.idle += dt;
			continue;
		}
		const file = (cf.url || cf.functionName).split(/[/]/).slice(-2).join("/");
		self.file[file] = (self.file[file] ?? 0) + dt;
		const key = `${cf.functionName || "(anon)"} @ ${file}:${cf.lineNumber}`;
		self.fn[key] = (self.fn[key] ?? 0) + dt;
		self.total += dt;
	}
	if (!byVer[meta.ver]) byVer[meta.ver] = [];
	byVer[meta.ver].push(self);
}
for (const [ver, list] of Object.entries(byVer)) {
	console.log(
		`\n== ${ver} (n=${list.length}) busy ${med(list.map((s) => s.total)).toFixed(0)} ms, idle ${med(list.map((s) => s.idle)).toFixed(0)} ms before the HUD page`,
	);
	const files = [...new Set(list.flatMap((s) => Object.keys(s.file)))]
		.map((k) => [k, med(list.map((s) => s.file[k] ?? 0))])
		.sort((x, y) => y[1] - x[1])
		.slice(0, 8);
	for (const [k, v] of files) console.log(`  ${v.toFixed(1).padStart(7)} ms  ${k}`);
}
const fnDiff = () => {
	const all = new Set(Object.values(byVer).flatMap((l) => l.flatMap((s) => Object.keys(s.fn))));
	const rows = [...all].map((k) => [
		k,
		med((byVer.main ?? []).map((s) => s.fn[k] ?? 0)) -
			med((byVer.v200 ?? []).map((s) => s.fn[k] ?? 0)),
	]);
	return rows.sort((x, y) => y[1] - x[1]).slice(0, 15);
};
console.log("\n== functions with the most extra self time in main (ms)");
for (const [k, v] of fnDiff()) console.log(`  ${v.toFixed(1).padStart(6)}  ${k}`);
