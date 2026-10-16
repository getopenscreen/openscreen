// Self time of HUD startup profiles attributed to original sources through the source maps.
// node attribute-hud.cjs <profilesDir> <ver>=<distAssetsDir> ...
const fs = require("node:fs");
const path = require("node:path");
const { SourceMapConsumer } = require("source-map-js");
const [dir, ...specs] = process.argv.slice(2);
const med = (a) => {
	const s = [...a].sort((x, y) => x - y);
	const h = s.length >> 1;
	return s.length ? (s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2) : 0;
};
const maps = {};
const per = {};
for (const spec of specs) {
	const [ver, assets] = spec.split("=");
	maps[ver] = {};
	for (const f of fs.readdirSync(assets).filter((f) => f.endsWith(".js.map")))
		maps[ver][f.replace(".map", "")] = new SourceMapConsumer(
			JSON.parse(fs.readFileSync(path.join(assets, f), "utf8")),
		);
	per[ver] = [];
	for (const f of fs
		.readdirSync(dir)
		.filter(
			(f) => f.startsWith(`hud-${ver}-`) && f.endsWith(".cpuprofile") && !f.includes("-r0."),
		)) {
		const p = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
		const nodes = new Map(p.nodes.map((n) => [n.id, n]));
		const acc = { "(total busy)": 0 };
		const cache = new Map();
		for (let i = 0; i < p.samples.length; i++) {
			const cf = nodes.get(p.samples[i]).callFrame;
			if (cf.functionName === "(idle)") continue;
			const dt = (p.timeDeltas[i + 1] ?? 0) / 1000;
			acc["(total busy)"] += dt;
			const file = (cf.url || "").split("/").pop();
			let key = cf.url ? `[${file.replace(/-[A-Za-z0-9_-]{8}\.js$/, ".js")}]` : cf.functionName;
			const m = maps[ver][file];
			if (m) {
				const ck = `${file}:${cf.lineNumber}:${cf.columnNumber}`;
				if (!cache.has(ck)) {
					const o = m.originalPositionFor({ line: cf.lineNumber + 1, column: cf.columnNumber });
					cache.set(
						ck,
						o.source
							? `${o.source.replace(/^.*?(node_modules|src)\//, "$1/")}${o.name ? ` ${o.name}` : ""}`
							: key,
					);
				}
				key = cache.get(ck);
			}
			acc[key] = (acc[key] ?? 0) + dt;
		}
		per[ver].push(acc);
	}
}
const [a, b] = Object.keys(per);
const keys = [...new Set(Object.values(per).flatMap((l) => l.flatMap((x) => Object.keys(x))))];
const rows = keys.map((k) => [
	k,
	med(per[a].map((x) => x[k] ?? 0)),
	med(per[b].map((x) => x[k] ?? 0)),
]);
console.log(`${a} n=${per[a].length}, ${b} n=${per[b].length}; self ms ${a} → ${b}`);
for (const [k, x, y] of rows.sort((p, q) => q[2] - q[1] - (p[2] - p[1])).slice(0, 25))
	console.log(
		`${x.toFixed(1).padStart(6)} → ${y.toFixed(1).padStart(6)}  ${(y - x >= 0 ? "+" : "") + (y - x).toFixed(1)}  ${k}`,
	);
// by source file
const fileOf = (k) => k.replace(/ [^ ]+$/, "");
const fk = [...new Set(keys.map(fileOf))];
const frows = fk.map((f) => [
	f,
	...[a, b].map((v) =>
		med(
			per[v].map((x) =>
				Object.entries(x)
					.filter(([k]) => fileOf(k) === f)
					.reduce((s, [, t]) => s + t, 0),
			),
		),
	),
]);
console.log("\nby source file, biggest increases");
for (const [f, x, y] of frows.sort((p, q) => q[2] - q[1] - (p[2] - p[1])).slice(0, 15))
	console.log(
		`${x.toFixed(1).padStart(6)} → ${y.toFixed(1).padStart(6)}  ${(y - x >= 0 ? "+" : "") + (y - x).toFixed(1)}  ${f}`,
	);
