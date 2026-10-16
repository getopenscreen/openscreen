// Median of each open phase per build (round 0 = warm-up, left out), and a Mann-Whitney z of each
// build against the first one listed.
// node summarize-open.mjs <dir> <build> [<build> ...]
import fs from "node:fs";
import path from "node:path";
import { mannWhitneyZ } from "./compare.mjs";

const [dir, ...builds] = process.argv.slice(2);
const runs = fs
	.readdirSync(dir)
	.filter((f) => /^open-.*\.json$/.test(f))
	.map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")))
	.filter((r) => r.ok && r.run > 0)
	.map((r) => ({ ...r, ver: r.pinned === false ? `${r.ver}-nopin` : r.ver }));
const med = (a) => {
	const s = [...a].sort((x, y) => x - y);
	const h = s.length >> 1;
	return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
};
const metrics = {
	hudReady: (r) => r.hudReadyAt,
	hudTarget: (r) => r.hudTargetAt,
	window: (r) => r.phases.windowToNavStart,
	dcl: (r) => r.phases.domContentLoaded,
	root: (r) => r.phases.rootRendered,
	video: (r) => r.phases.videoElement,
	meta: (r) => r.phases.videoMetadata,
	frame: (r) => r.phases.firstFrame,
	total: (r) => r.phases.total,
};
const ref = runs.filter((r) => r.ver === builds[0]);
console.log(
	`build      n  ${Object.keys(metrics)
		.map((k) => k.padStart(9))
		.join("")}   z(total) z(hud)`,
);
for (const b of builds) {
	const g = runs.filter((r) => r.ver === b);
	if (!g.length) continue;
	const cells = Object.values(metrics).map((f) => med(g.map(f)).toFixed(0).padStart(9));
	const z = (f) => mannWhitneyZ(ref.map(f), g.map(f)).toFixed(2).padStart(7);
	console.log(
		`${b.padEnd(10)} ${String(g.length).padStart(2)} ${cells.join("")} ${z(metrics.total)} ${z(metrics.hudReady)}`,
	);
}
