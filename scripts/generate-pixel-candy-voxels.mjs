// Pixel Candy, drawn once as pixel art: this grid is both the 2D cursor (its PNGs) and the 3D
// model (one cube per pixel, mode 15, theme 3).
// Run with `node scripts/generate-pixel-candy-voxels.mjs` after changing a grid below: it writes
// public/cursors/pixel-candy/{arrow,pointer}.png, design/cursors/pixel-candy/source.png, and the
// PIX_* tables of the three compositor shaders between their `<pixel-candy-voxels>` markers, then
// prints the hotspots for src/lib/cursor/cursorThemes.ts.
//
// `O` is the plum outline, `P` the pink body, `H` its pale highlight down the lit edge, `.`
// nothing. The shade is not drawn: a body pixel with the outline right of it or under it turns
// darker pink by itself. The hotspot is the top-left corner of the arrow's first pixel and the top
// middle of the index; in the 3D prototype frame (crates/compositor/src/sculpt.rs) it is the
// origin.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SHADERS = path.join(ROOT, "crates", "compositor", "src");
// Mirrors SCULPT_VOX in the shaders and VOX in sculpt.rs: sixteen rows make a cursor one unit tall.
const VOX = 0.0625;
// Sprite pixels per art pixel, in the 128px sprite: sixteen rows fill the 112px the other themes
// use.
const CELL = 7;
const SPRITE = 128;

const SHAPES = [
	{
		name: "arrow",
		// Hotspot column: the left edge of the first pixel.
		hotspotColumn: 0,
		grid: [
			"O..........",
			"OO.........",
			"OHO........",
			"OHPO.......",
			"OHPPO......",
			"OHPPPO.....",
			"OHPPPPO....",
			"OHPPPPPO...",
			"OHPPPPPPO..",
			"OHPPPPPPPO.",
			"OHPPPPOOOOO",
			"OHPOHPO....",
			"OHO.OHPO...",
			"OO..OHPO...",
			".....OHPO..",
			"......OO...",
		],
	},
	{
		name: "pointer",
		// Between the index's two columns.
		hotspotColumn: 5,
		grid: [
			"....OO..........",
			"...OHPO.........",
			"...OHPO.........",
			"...OHPO.........",
			"...OHPOOO.......",
			"...OHPOPPOOO....",
			"...OHPOPPOPPOOO.",
			".OOOHPOPPOPPOPPO",
			"OHHOHPPPPPPPPPPO",
			"OHPPHPPPPPPPPPPO",
			".OHPPPPPPPPPPPPO",
			".OHPPPPPPPPPPPO.",
			"..OHPPPPPPPPPPO.",
			"..OHPPPPPPPPPO..",
			"...OHPPPPPPPPO..",
			"...OOOOOOOOOOO..",
		],
	},
];

// sRGB, in the order of the shader's colour classes.
const COLOURS = { O: [74, 31, 92], P: [255, 111, 168], H: [255, 200, 222], S: [222, 70, 130] };

// The grid with its shade pixels.
function shaded(grid) {
	const at = (c, r) => grid[r]?.[c] ?? ".";
	return grid.map((row, r) =>
		[...row]
			.map((ch, c) => (ch === "P" && (at(c + 1, r) === "O" || at(c, r + 1) === "O") ? "S" : ch))
			.join(""),
	);
}

const shapes = SHAPES.map((shape) => {
	const grid = shaded(shape.grid);
	const cols = Math.max(...grid.map((row) => row.length));
	const rows = grid.length;
	const mask = (test) =>
		grid.map((row) => [...row].reduce((m, ch, c) => (test(ch) ? m | (1 << c) : m), 0));
	return {
		...shape,
		grid,
		cols,
		rows,
		origin: [-shape.hotspotColumn * VOX, 0],
		body: mask((ch) => ch !== "."),
		line: mask((ch) => ch === "O"),
		hi: mask((ch) => ch === "H"),
		shade: mask((ch) => ch === "S"),
	};
});

// The body as rectangles (centre, half size, prototype units): each row's runs, merged with the
// rows below while the run stays the same. The shadow uses their exact outline.
function rects(shape) {
	const open = [];
	const done = [];
	shape.body.forEach((m, r) => {
		const runs = [];
		for (let c = 0; c < shape.cols; c++) {
			if (!(m & (1 << c))) continue;
			const start = c;
			while (c + 1 < shape.cols && m & (1 << (c + 1))) c++;
			runs.push([start, c]);
		}
		for (const box of open.splice(0)) {
			const k = runs.findIndex(([a, b]) => a === box.a && b === box.b);
			if (k >= 0) {
				box.r1 = r;
				runs.splice(k, 1);
				open.push(box);
			} else done.push(box);
		}
		for (const [a, b] of runs) open.push({ a, b, r0: r, r1: r });
	});
	done.push(...open);
	return done.map(({ a, b, r0, r1 }) => {
		const [ox, oy] = shape.origin;
		const [x0, x1] = [ox + a * VOX, ox + (b + 1) * VOX];
		const [y0, y1] = [oy - (r1 + 1) * VOX, oy - r0 * VOX];
		return [(x0 + x1) / 2, (y0 + y1) / 2, (x1 - x0) / 2, (y1 - y0) / 2];
	});
}

const boxes = shapes.map(rects);
const rectStarts = boxes.reduce((s, b) => [...s, s[s.length - 1] + b.length], [0]);
const grids = [];
let at = 0;
for (const s of shapes) {
	grids.push([s.cols, s.rows, at, 0]);
	at += s.rows;
}
const bounds = shapes.map(({ origin: [ox, oy], cols, rows }) => [
	ox + (cols * VOX) / 2,
	oy - (rows * VOX) / 2,
	(cols * VOX) / 2,
	(rows * VOX) / 2,
]);

// ---- PNG ----

const CRC = new Uint32Array(256).map((_, n) => {
	let c = n;
	for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
	return c >>> 0;
});
function crc32(bytes) {
	let c = 0xffffffff;
	for (const b of bytes) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
	const out = Buffer.alloc(12 + data.length);
	out.writeUInt32BE(data.length, 0);
	out.write(type, 4, "ascii");
	data.copy(out, 8);
	out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
	return out;
}
function png(width, height, rgba) {
	const header = Buffer.alloc(13);
	header.writeUInt32BE(width, 0);
	header.writeUInt32BE(height, 4);
	header.set([8, 6, 0, 0, 0], 8);
	const raw = Buffer.alloc((width * 4 + 1) * height);
	for (let y = 0; y < height; y++)
		rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", header),
		chunk("IDAT", deflateSync(raw, { level: 9 })),
		chunk("IEND", Buffer.alloc(0)),
	]);
}
// The grid at `cell` pixels per art pixel, its top-left at (x0, y0) of a `w` × `h` canvas.
function paint(rgba, w, shape, cell, x0, y0) {
	shape.grid.forEach((row, r) => {
		[...row].forEach((ch, c) => {
			if (ch === ".") return;
			for (let y = 0; y < cell; y++) {
				for (let x = 0; x < cell; x++) {
					const i = ((y0 + r * cell + y) * w + x0 + c * cell + x) * 4;
					rgba.set([...COLOURS[ch], 255], i);
				}
			}
		});
	});
}

const cursors = path.join(ROOT, "public", "cursors", "pixel-candy");
await mkdir(cursors, { recursive: true });
const hotspots = [];
for (const shape of shapes) {
	const x0 = Math.round((SPRITE - shape.cols * CELL) / 2);
	const y0 = Math.round((SPRITE - shape.rows * CELL) / 2);
	const rgba = Buffer.alloc(SPRITE * SPRITE * 4);
	paint(rgba, SPRITE, shape, CELL, x0, y0);
	await writeFile(path.join(cursors, `${shape.name}.png`), png(SPRITE, SPRITE, rgba));
	// On the 32-logical reference of cursorThemes.ts.
	hotspots.push([
		shape.name,
		((x0 + shape.hotspotColumn * CELL) * 32) / SPRITE,
		(y0 * 32) / SPRITE,
	]);
}

// The design master, arrow on the left and hand on the right, like the other themes' sources.
{
	const [w, h, cell] = [1774, 887, 40];
	const rgba = Buffer.alloc(w * h * 4);
	shapes.forEach((shape, i) => {
		const x0 = Math.round(i * (w / 2) + (w / 2 - shape.cols * cell) / 2);
		paint(rgba, w, shape, cell, x0, Math.round((h - shape.rows * cell) / 2));
	});
	await writeFile(
		path.join(ROOT, "design", "cursors", "pixel-candy", "source.png"),
		png(w, h, rgba),
	);
}

// ---- Shader tables ----

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
	const tables = [
		["PIX_BODY", shapes.flatMap((s) => s.body)],
		["PIX_LINE", shapes.flatMap((s) => s.line)],
		["PIX_HI", shapes.flatMap((s) => s.hi)],
		["PIX_SHADE", shapes.flatMap((s) => s.shade)],
		["PIX_RECT_N", rectStarts],
	];
	const vectors = [
		["PIX_GRID", t.i4, grids],
		["PIX_ORIGIN", t.f2, shapes.map((s) => s.origin)],
		["PIX_BOX", t.f4, bounds],
		["PIX_RECT", t.f4, boxes.flat()],
	];
	if (lang === "wgsl") {
		return [
			...tables.map(([n, v]) => `const ${n} = array<i32, ${v.length}>(${v.join(", ")});`),
			...vectors.map(
				([n, ty, v]) =>
					`const ${n} = array<${ty}, ${v.length}>(\n    ${v.map((x) => vec(ty, x)).join(",\n    ")}\n);`,
			),
		].join("\n");
	}
	const decl = lang === "hlsl" ? "static const" : "constant";
	return [
		...tables.map(([n, v]) => `${decl} int ${n}[${v.length}] = { ${v.join(", ")} };`),
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
for (const [name, x, y] of hotspots) console.log(`${name}: hotspotX ${x}, hotspotY ${y}`);
