// Markdown rows "metric | 2.0.0 | main | delta | verdict" from an aggregate { "<group>|v200": {...}, "<group>|main": {...} }.
// A regression is a change over 5% in the bad direction that is real: with 6 runs or more per side,
// a Mann-Whitney test at p < 0.05 (two-sided); with fewer, [min-max] ranges that do not overlap.
// Over 5% without that is reported as within noise.

/** Normal approximation of the Mann-Whitney U test: z of "b tends to be larger than a". */
export function mannWhitneyZ(a, b) {
	let u = 0;
	for (const x of b) for (const y of a) u += x > y ? 1 : x === y ? 0.5 : 0;
	const n1 = a.length;
	const n2 = b.length;
	return (u - (n1 * n2) / 2) / Math.sqrt((n1 * n2 * (n1 + n2 + 1)) / 12);
}
export function compareRows(agg, group, metrics) {
	const a = agg[`${group}|v200`];
	const b = agg[`${group}|main`];
	const rows = [];
	for (const [key, label, better, digits = 1] of metrics) {
		const x = a?.[key];
		const y = b?.[key];
		if (!x && !y) continue;
		const fmt = (v) =>
			v ? `${v.med.toFixed(digits)} [${v.min.toFixed(digits)}–${v.max.toFixed(digits)}]` : "n/a";
		let delta = "n/a";
		let verdict = "n/a";
		let tested = false;
		let z = 0;
		if (x && y) {
			const d =
				x.med === 0
					? y.med === 0
						? 0
						: Number.POSITIVE_INFINITY
					: ((y.med - x.med) / Math.abs(x.med)) * 100;
			delta = Number.isFinite(d)
				? `${d >= 0 ? "+" : ""}${d.toFixed(1)}%`
				: `${x.med.toFixed(digits)} → ${y.med.toFixed(digits)}`;
			const worse = better === "lower" ? d > 5 : d < -5;
			const improved = better === "lower" ? d < -5 : d > 5;
			tested = x.vals?.length >= 6 && y.vals?.length >= 6;
			z = tested ? mannWhitneyZ(x.vals, y.vals) : 0;
			const overlap = tested ? Math.abs(z) < 1.96 : !(y.min > x.max || y.max < x.min);
			if (better === "info") verdict = "info";
			else if (worse) verdict = overlap ? "within noise" : "**regression**";
			else if (improved) verdict = overlap ? "within noise" : "improvement";
			else verdict = tested && Math.abs(z) >= 1.96 ? "under 5%, but significant" : "same";
		}
		if (tested && /regression|improvement|noise/.test(verdict))
			verdict += ` (p ${Math.abs(z) >= 1.96 ? "<" : "≥"} 0.05)`;
		rows.push(`| ${label} | ${fmt(x)} | ${fmt(y)} | ${delta} | ${verdict} |`);
	}
	return rows;
}
