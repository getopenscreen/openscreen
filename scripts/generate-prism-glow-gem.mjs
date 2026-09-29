// Cut-gem geometry of the Prism Glow 3D cursors (mode 15, theme 1).
// Run with `node scripts/generate-prism-glow-gem.mjs` after changing a piece below: it rewrites
// the GEM_PLANES, GEM_PIECE and GEM_BOX tables of the three compositor shaders, between their
// `<prism-glow-gem>` markers.
//
// Every piece is a convex polyhedron, stored as the planes of its faces (unit outward normal,
// offset): the shader takes the max of a piece's planes and the min over the pieces. Coordinates
// are the prototype frame of crates/compositor/src/sculpt.rs: cursor height 1, x right, y UP,
// z toward the camera, hotspot at the origin, screen at z = 0, underside of every model at
// SCULPT_HOVER.

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SHADERS = path.join(ROOT, "crates", "compositor", "src");
const HOVER = 0.05;

// Both models follow the reference sheet (design/cursors/3d-concept.png) and are built the same
// way. A piece is its outline (convex, counter-clockwise), the top of its wall `zg`, a crown ring
// inset by `c` at `zc` (its edge midpoints raised by `lift`, which splits every crown facet in
// two), and the points its facets rise to; the piece is the convex hull of all of them.

// The arrow: a head with a wide girdle and a crown that fans out from one point, and the tail.
const ARROW = [
	{
		name: "head",
		outline: [
			[-0.02, 0.03],
			[-0.02, -0.88],
			[0.7, -0.62],
		],
		zg: 0.12,
		c: 0.07,
		zc: 0.17,
		lift: 0.02,
		tops: [[0.18, -0.42, 0.27]],
	},
	{
		name: "tail",
		outline: [
			[0.19, -0.66],
			[0.33, -1.0],
			[0.57, -0.92],
			[0.43, -0.6],
		],
		zg: 0.12,
		c: 0.05,
		zc: 0.165,
		lift: 0.012,
		tops: [[0.38, -0.79, 0.23]],
	},
];

// The hand: an index column, three fingers side by side, the thumb and the palm, all on the same
// slab. The fingers stand higher than the palm where they overlap it, so their crease with the
// palm is the knuckle line.
const HAND = [
	{
		name: "index",
		outline: [
			[-0.14, -0.72],
			[0.14, -0.72],
			[0.14, -0.09],
			[0.065, 0.0],
			[-0.065, 0.0],
			[-0.14, -0.09],
		],
		zg: 0.15,
		c: 0.03,
		zc: 0.2,
		tops: [
			[-0.035, -0.045, 0.25],
			[0.035, -0.045, 0.25],
			[0.0, -0.5, 0.3],
		],
	},
	{
		name: "middle",
		outline: [
			[0.12, -0.68],
			[0.29, -0.68],
			[0.29, -0.34],
			[0.25, -0.29],
			[0.16, -0.29],
			[0.12, -0.33],
		],
		zg: 0.15,
		c: 0.025,
		zc: 0.185,
		tops: [
			[0.205, -0.345, 0.23],
			[0.205, -0.57, 0.275],
		],
	},
	{
		name: "ring",
		outline: [
			[0.27, -0.68],
			[0.44, -0.68],
			[0.44, -0.395],
			[0.4, -0.345],
			[0.31, -0.345],
			[0.27, -0.385],
		],
		zg: 0.15,
		c: 0.025,
		zc: 0.185,
		tops: [
			[0.355, -0.4, 0.23],
			[0.355, -0.59, 0.27],
		],
	},
	{
		name: "pinky",
		outline: [
			[0.42, -0.7],
			[0.585, -0.7],
			[0.585, -0.45],
			[0.545, -0.4],
			[0.46, -0.4],
			[0.42, -0.44],
		],
		zg: 0.15,
		c: 0.025,
		zc: 0.185,
		tops: [
			[0.5, -0.455, 0.23],
			[0.5, -0.61, 0.265],
		],
	},
	{
		name: "thumb",
		outline: [
			[-0.36, -0.62],
			[-0.13, -0.8],
			[-0.1, -0.5],
			[-0.2, -0.37],
			[-0.31, -0.37],
			[-0.37, -0.44],
		],
		zg: 0.15,
		c: 0.03,
		zc: 0.19,
		tops: [
			[-0.25, -0.47, 0.27],
			[-0.2, -0.6, 0.28],
			[-0.3, -0.55, 0.25],
		],
	},
	{
		name: "palm",
		outline: [
			[-0.34, -0.6],
			[-0.08, -1.0],
			[0.38, -1.0],
			[0.585, -0.74],
			[0.585, -0.54],
			[-0.12, -0.5],
		],
		zg: 0.15,
		c: 0.035,
		zc: 0.18,
		tops: [
			[-0.04, -0.63, 0.3],
			[0.26, -0.67, 0.29],
			[0.03, -0.9, 0.24],
			[0.47, -0.68, 0.26],
			[0.22, -0.86, 0.265],
			[-0.19, -0.7, 0.255],
			[0.43, -0.84, 0.235],
		],
	},
];

const sub = (a, b) => a.map((v, i) => v - b[i]);
const dot = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0);
const cross = (a, b) => [
	a[1] * b[2] - a[2] * b[1],
	a[2] * b[0] - a[0] * b[2],
	a[0] * b[1] - a[1] * b[0],
];

function plane(n, w) {
	const len = Math.hypot(...n);
	return [...n.map((v) => v / len), w / len];
}

function edgeFrame(a, b) {
	const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
	const d = [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
	return { len, d, inward: [-d[1], d[0]] };
}

// The outline moved inward by `c`: the offset edges, each crossed with the previous one.
function inset(outline, c) {
	const lines = outline.map((a, i) => {
		const { d, inward } = edgeFrame(a, outline[(i + 1) % outline.length]);
		return { p: [a[0] + inward[0] * c, a[1] + inward[1] * c], d };
	});
	return lines.map(({ p: p2, d: d2 }, i) => {
		const { p: p1, d: d1 } = lines[(i + lines.length - 1) % lines.length];
		const det = d1[0] * -d2[1] + d2[0] * d1[1];
		const t = ((p2[0] - p1[0]) * -d2[1] + d2[0] * (p2[1] - p1[1])) / det;
		return [p1[0] + d1[0] * t, p1[1] + d1[1] * t];
	});
}

function gemPoints({ outline, zg, c, zc, lift = 0, tops }) {
	const ring = inset(outline, c);
	const mids = lift
		? ring.map(([x, y], i) => {
				const [u, v] = ring[(i + 1) % ring.length];
				return [(x + u) / 2, (y + v) / 2, zc + lift];
			})
		: [];
	return [
		...outline.map(([x, y]) => [x, y, HOVER]),
		...outline.map(([x, y]) => [x, y, zg]),
		...ring.map(([x, y]) => [x, y, zc]),
		...mids,
		...tops,
	];
}

// Faces of the convex hull: every plane through three of the points with all the others behind.
function hullPlanes(points) {
	const planes = [];
	const eps = 1e-7;
	for (let i = 0; i < points.length; i++) {
		for (let j = i + 1; j < points.length; j++) {
			for (let k = j + 1; k < points.length; k++) {
				const n = cross(sub(points[j], points[i]), sub(points[k], points[i]));
				if (Math.hypot(...n) < 1e-9) continue;
				let p = plane(n, dot(n, points[i]));
				const side = points.map((q) => dot(p.slice(0, 3), q) - p[3]);
				if (side.some((s) => s > eps) && side.some((s) => s < -eps)) continue;
				if (side.some((s) => s > eps)) p = p.map((v) => -v);
				if (!planes.some((q) => q.every((v, m) => Math.abs(v - p[m]) < 1e-6))) planes.push(p);
			}
		}
	}
	return planes;
}

function box(points) {
	const lo = [0, 1, 2].map((i) => Math.min(...points.map((p) => p[i])));
	const hi = [0, 1, 2].map((i) => Math.max(...points.map((p) => p[i])));
	return [lo.map((v, i) => (v + hi[i]) / 2), lo.map((v, i) => (hi[i] - v) / 2 + 0.01)];
}

const pieces = [...ARROW, ...HAND].map((piece) => hullPlanes(gemPoints(piece)));
const planes = pieces.flat();
const starts = pieces.reduce((s, p) => [...s, s[s.length - 1] + p.length], [0]);
const boxes = [...box(ARROW.flatMap(gemPoints)), ...box(HAND.flatMap(gemPoints))];

const num = (v, digits) => {
	const s = v.toFixed(digits);
	return Number(s) === 0 ? (0).toFixed(digits) : s;
};

function block(lang) {
	const v4 = { wgsl: "vec4<f32>", hlsl: "float4", metal: "float4" }[lang];
	const v3 = { wgsl: "vec3<f32>", hlsl: "float3", metal: "float3" }[lang];
	const rows = [];
	for (let i = 0; i < planes.length; i += 2) {
		const pair = planes.slice(i, i + 2).map((p) => `${v4}(${p.map((v) => num(v, 4)).join(", ")})`);
		rows.push(`    ${pair.join(", ")}`);
	}
	const boxRows = boxes.map((b) => `    ${v3}(${b.map((v) => num(v, 3)).join(", ")})`);
	if (lang === "wgsl") {
		return [
			`const GEM_PLANES = array<vec4<f32>, ${planes.length}>(`,
			rows.join(",\n"),
			");",
			`const GEM_PIECE = array<i32, ${starts.length}>(${starts.join(", ")});`,
			"const GEM_BOX = array<vec3<f32>, 4>(",
			boxRows.join(",\n"),
			");",
		].join("\n");
	}
	const decl = lang === "hlsl" ? "static const" : "constant";
	return [
		`${decl} float4 GEM_PLANES[${planes.length}] = {`,
		rows.join(",\n"),
		"};",
		`${decl} int GEM_PIECE[${starts.length}] = { ${starts.join(", ")} };`,
		`${decl} float3 GEM_BOX[4] = {`,
		boxRows.join(",\n"),
		"};",
	].join("\n");
}

const targets = [
	["vk_shaders/layer.wgsl", "wgsl"],
	["shaders.hlsl", "hlsl"],
	["shaders.metal", "metal"],
];
const marked = /(\/\/ <prism-glow-gem>\n)[\s\S]*?(\/\/ <\/prism-glow-gem>)/;
const sources = await Promise.all(
	targets.map(([file]) => readFile(path.join(SHADERS, file), "utf8")),
);
targets.forEach(([file], i) => {
	if (!marked.test(sources[i])) throw new Error(`${file}: no <prism-glow-gem> markers`);
});
for (const [i, [file, lang]] of targets.entries()) {
	const src = sources[i].replace(marked, (_, open, close) => `${open}${block(lang)}\n${close}`);
	await writeFile(path.join(SHADERS, file), src);
}
console.log(
	`${planes.length} planes: ${[...ARROW, ...HAND].map((g, i) => `${g.name} ${pieces[i].length}`).join(", ")}`,
);
