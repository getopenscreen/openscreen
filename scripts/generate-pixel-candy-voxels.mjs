// Voxel grids of the Pixel Candy 3D cursors (mode 15, theme 3).
// Run with `node scripts/generate-pixel-candy-voxels.mjs` after changing a grid below: it rewrites
// the PIX_* tables of the three compositor shaders, between their `<pixel-candy-voxels>` markers.
//
// A grid is drawn after the reference sheet (design/cursors/3d-concept.png), row 0 at the top:
// `P` a pink voxel, `M` a mint one, `.` nothing. The purple ring is not drawn: it is every empty
// cell that touches a voxel, sides and corners, and stands a little behind the face. The hotspot
// (prototype origin, see crates/compositor/src/sculpt.rs) is the top-left corner of the arrow's
// first voxel and the top middle of the index.

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SHADERS = path.join(ROOT, "crates", "compositor", "src");
// Mirrors SCULPT_VOX in the shaders and VOX in sculpt.rs.
const VOX = 0.07;

const ARROW = {
	origin: [0, 0],
	grid: [
		"P......",
		"PP.....",
		"PPP....",
		"PPPP...",
		"PPPPP..",
		"MPPPPP.",
		"MPPPPPP",
		"MPPPP..",
		"MP.MP..",
		"MM.MPP.",
		"M...MPP",
		".....MP",
	],
};

const HAND = {
	origin: [-4 * VOX, 0],
	grid: [
		"...PP........",
		"...PP........",
		"...PP........",
		"...PP........",
		"...PP.PP.....",
		"...PP.PP.PP..",
		"PP.PP.PP.PPPP",
		"MPPPPPPPPPPPP",
		".MPPPPPPPPPPP",
		"..MPPPPPPPPPP",
		"...MPPPPPPPP.",
		"....MPPPPPP..",
		".....MPPPP...",
	],
};

const SHAPES = [ARROW, HAND];

function masks({ grid }) {
	const cols = grid[0].length;
	const rows = grid.length;
	const at = (c, r) => r >= 0 && r < rows && c >= 0 && c < cols && grid[r][c] !== ".";
	const body = grid.map((line) =>
		[...line].reduce((m, ch, c) => (ch === "." ? m : m | (1 << c)), 0),
	);
	const mint = grid.map((line) =>
		[...line].reduce((m, ch, c) => (ch === "M" ? m | (1 << c) : m), 0),
	);
	const ring = [];
	for (let r = -1; r <= rows; r++) {
		let m = 0;
		for (let c = -1; c <= cols; c++) {
			if (at(c, r)) continue;
			let touches = false;
			for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) touches ||= at(c + i, r + j);
			if (touches) m |= 1 << (c + 1);
		}
		ring.push(m);
	}
	return { cols, rows, body, mint, ring };
}

// Face and ring as rectangles (centre, half size, prototype units): each row's runs, merged with
// the rows below while the run stays the same. The shadow uses their exact outline.
function rects({ origin }, { cols, rows, body, ring }) {
	const full = ring.map((m, i) => m | ((i >= 1 && i <= rows ? body[i - 1] : 0) << 1));
	const runs = full.map((m) => {
		const out = [];
		for (let c = 0; c < cols + 2; c++) {
			if (!(m & (1 << c))) continue;
			const start = c;
			while (c + 1 < cols + 2 && m & (1 << (c + 1))) c++;
			out.push([start, c]);
		}
		return out;
	});
	const open = [];
	const done = [];
	runs.forEach((row, r) => {
		for (const box of open.splice(0)) {
			const k = row.findIndex(([a, b]) => a === box.a && b === box.b);
			if (k >= 0) {
				box.r1 = r;
				row.splice(k, 1);
				open.push(box);
			} else done.push(box);
		}
		for (const [a, b] of row) open.push({ a, b, r0: r, r1: r });
	});
	done.push(...open);
	return done.map(({ a, b, r0, r1 }) => {
		const x0 = origin[0] + (a - 1) * VOX;
		const x1 = origin[0] + b * VOX;
		const y0 = origin[1] - (r1 - 1 + 1) * VOX;
		const y1 = origin[1] - (r0 - 1) * VOX;
		return [(x0 + x1) / 2, (y0 + y1) / 2, (x1 - x0) / 2, (y1 - y0) / 2];
	});
}

const data = SHAPES.map((s) => ({ shape: s, ...masks(s) }));
const boxes = data.map((d) => rects(d.shape, d));
const grid = [];
let bodyAt = 0;
let ringAt = 0;
for (const d of data) {
	grid.push([d.cols, d.rows, bodyAt, ringAt]);
	bodyAt += d.rows;
	ringAt += d.rows + 2;
}
const rectStarts = boxes.reduce((s, b) => [...s, s[s.length - 1] + b.length], [0]);
// Bounding box of face and ring (centre, half size), for the bound away from the grid.
const bounds = boxes.map((list) => {
	const x0 = Math.min(...list.map((b) => b[0] - b[2]));
	const x1 = Math.max(...list.map((b) => b[0] + b[2]));
	const y0 = Math.min(...list.map((b) => b[1] - b[3]));
	const y1 = Math.max(...list.map((b) => b[1] + b[3]));
	return [(x0 + x1) / 2, (y0 + y1) / 2, (x1 - x0) / 2, (y1 - y0) / 2];
});

const num = (v) => {
	const s = v.toFixed(4);
	return Number(s) === 0 ? "0.0" : s.replace(/0+$/, "").replace(/\.$/, ".0");
};

function block(lang) {
	const t = {
		wgsl: { i4: "vec4<i32>", f2: "vec2<f32>", f4: "vec4<f32>" },
		hlsl: { i4: "int4", f2: "float2", f4: "float4" },
		metal: { i4: "int4", f2: "float2", f4: "float4" },
	}[lang];
	const vec = (type, v) =>
		`${type}(${v.map((x) => (type === t.i4 ? String(x) : num(x))).join(", ")})`;
	const ints = (list) => list.join(", ");
	const tables = [
		["PIX_BODY", "i32", data.flatMap((d) => d.body)],
		["PIX_MINT", "i32", data.flatMap((d) => d.mint)],
		["PIX_RING", "i32", data.flatMap((d) => d.ring)],
		["PIX_RECT_N", "i32", rectStarts],
	];
	const vectors = [
		["PIX_GRID", t.i4, grid],
		["PIX_ORIGIN", t.f2, SHAPES.map((s) => s.origin)],
		["PIX_BOX", t.f4, bounds],
		["PIX_RECT", t.f4, boxes.flat()],
	];
	if (lang === "wgsl") {
		return [
			...tables.map(([n, ty, v]) => `const ${n} = array<${ty}, ${v.length}>(${ints(v)});`),
			...vectors.map(
				([n, ty, v]) =>
					`const ${n} = array<${ty}, ${v.length}>(\n    ${v.map((x) => vec(ty, x)).join(",\n    ")}\n);`,
			),
		].join("\n");
	}
	const decl = lang === "hlsl" ? "static const" : "constant";
	const scalar = { i32: "int" };
	return [
		...tables.map(([n, ty, v]) => `${decl} ${scalar[ty]} ${n}[${v.length}] = { ${ints(v)} };`),
		...vectors.map(
			([n, ty, v]) =>
				`${decl} ${ty} ${n}[${v.length}] = {\n    ${v.map((x) => vec(ty, x)).join(",\n    ")}\n};`,
		),
	].join("\n");
}

const targets = [
	["vk_shaders/layer.wgsl", "wgsl"],
	["shaders.hlsl", "hlsl"],
	["shaders.metal", "metal"],
];
const marked = /(\/\/ <pixel-candy-voxels>\n)[\s\S]*?(\/\/ <\/pixel-candy-voxels>)/;
const sources = await Promise.all(
	targets.map(([file]) => readFile(path.join(SHADERS, file), "utf8")),
);
targets.forEach(([file], i) => {
	if (!marked.test(sources[i])) throw new Error(`${file}: no <pixel-candy-voxels> markers`);
});
for (const [i, [file, lang]] of targets.entries()) {
	const src = sources[i].replace(marked, (_, open, close) => `${open}${block(lang)}\n${close}`);
	await writeFile(path.join(SHADERS, file), src);
}
console.log(
	data
		.map(
			(d, i) =>
				`${["arrow", "hand"][i]}: ${d.cols}×${d.rows} voxels, ${boxes[i].length} shadow rects`,
		)
		.join("; "),
);
