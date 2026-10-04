// Glass Lens has no raster master: its arrow and hand are the shapes the compositor models
// (`s_glass2` in crates/compositor/src/shaders.hlsl), and this script draws the theme picker's
// PNGs from those same distance fields. The shape tables and the GLASS_* widths are read from the
// HLSL and the model boxes from sculpt.rs, so the 2D art cannot drift from the model.
// The compositor never draws these PNGs: with the 3D option off it renders the glass itself
// (mode 19), refracting the picture under it, and in 3D it ray-marches the model. They only have
// to read as glass in a picker cell: a translucent body, the dark outline, a pale glass rim.
// Run with `node scripts/generate-glass-lens-cursor.mjs` after changing the shapes: it writes
// public/cursors/glass-lens/{arrow,pointer}.png and prints the hotspots for
// src/lib/cursor/cursorThemes.ts.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "crates", "compositor", "src");
const OUT = path.join(ROOT, "public", "cursors", "glass-lens");
const SPRITE = 128;
// Samples per pixel side, for the antialiasing.
const SS = 4;

const hlsl = await readFile(path.join(SRC, "shaders.hlsl"), "utf8");
const sculpt = await readFile(path.join(SRC, "sculpt.rs"), "utf8");

function constant(src, name) {
	const m = src.match(new RegExp(`static const float ${name} = (-?[\\d.]+);`));
	if (!m) throw new Error(`${name} not found in shaders.hlsl`);
	return Number(m[1]);
}
// The numbers of the HLSL table `name`, vector constructors dropped, in groups of `n`.
function table(src, name, n) {
	const decl = src.match(new RegExp(`${name}\\[\\d+\\] = \\{([^}]*)\\}`));
	if (!decl) throw new Error(`${name} not found in shaders.hlsl`);
	const values = decl[1]
		.replace(/float[234]/g, "")
		.match(/-?\d+(\.\d+)?/g)
		.map(Number);
	return Array.from({ length: values.length / n }, (_, i) => values.slice(i * n, i * n + n));
}
function box(name) {
	const m = sculpt.match(new RegExp(`const ${name}: \\[f32; 3\\] = \\[([^\\]]*)\\]`));
	if (!m) throw new Error(`${name} not found in sculpt.rs`);
	return m[1].split(",").map(Number);
}

const SCULPT_SCALE = constant(hlsl, "SCULPT_SCALE");
const LINE = constant(hlsl, "GLASS_LINE");
const RIM = constant(hlsl, "GLASS_RIM");
const RIM_POLY = table(hlsl, "RIM_POLY", 2);
const RIM_GLOVE = table(hlsl, "RIM_GLOVE", 4);
const RIM_GLOVE_R = table(hlsl, "RIM_GLOVE_R", 4);

// ---- The shapes, as `s_rim_poly`, `s_rim_glove` and `s_glass2` in the shaders ----

const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const clamp01 = (x) => Math.min(Math.max(x, 0), 1);

function segment(p, a, b) {
	const pa = sub(p, a);
	const ba = sub(b, a);
	const h = clamp01(dot(pa, ba) / dot(ba, ba));
	return Math.hypot(pa[0] - ba[0] * h, pa[1] - ba[1] * h);
}

function rimPoly(p, base) {
	let d = dot(sub(p, RIM_POLY[base]), sub(p, RIM_POLY[base]));
	let s = 1;
	for (let i = base, j = base + 6; i < base + 7; j = i, i++) {
		const e = sub(RIM_POLY[j], RIM_POLY[i]);
		const w = sub(p, RIM_POLY[i]);
		const h = clamp01(dot(w, e) / dot(e, e));
		d = Math.min(d, (w[0] - e[0] * h) ** 2 + (w[1] - e[1] * h) ** 2);
		const c0 = p[1] >= RIM_POLY[i][1];
		const c1 = p[1] < RIM_POLY[j][1];
		const c2 = e[0] * w[1] > e[1] * w[0];
		if ((c0 && c1 && c2) || (!c0 && !c1 && !c2)) s = -s;
	}
	return s * Math.sqrt(d);
}

function smin(a, b, k) {
	const h = Math.max(k - Math.abs(a - b), 0) / k;
	return Math.min(a, b) - h * h * k * 0.25;
}

function rimGlove(p, g, palm) {
	const [r0, r1, r2] = [0, 1, 2].map((k) => RIM_GLOVE_R[3 * g + k]);
	const seg = (k, r) =>
		segment(p, RIM_GLOVE[9 * g + k].slice(0, 2), RIM_GLOVE[9 * g + k].slice(2)) - r;
	const fingers = Math.min(
		seg(0, r0[0]),
		seg(1, r0[1]),
		seg(2, r0[2]),
		seg(3, r0[3]),
		seg(4, r1[0]),
	);
	const grooves = Math.min(seg(5, r1[1]), seg(6, r1[2]), seg(7, r1[3]));
	const sil = smin(palm, fingers, 0.03);
	const v = RIM_GLOVE[9 * g + 8];
	const wedge = Math.max(-dot(sub(p, v.slice(0, 2)), v.slice(2)), p[0] + r2[0], r2[1] - p[1]);
	return [sil, Math.max(sil, -Math.min(grooves, wedge))];
}

// [silhouette, lens]: signed distances in the prototype frame, negative inside.
function glass2(p, shape) {
	if (shape === "arrow") {
		const poly = rimPoly([p[0], p[1] + RIM - 0.06], 0);
		return [poly - RIM, poly];
	}
	const q = [p[0], p[1] + RIM - RIM_GLOVE_R[5][2]];
	const v = rimGlove(q, 1, rimPoly(q, 14) - 0.05);
	return [v[0] - RIM, v[1]];
}

// ---- The picker art ----

// Light from the top left, as `MODEL_LIGHT` in the shaders (x right, y up here).
const LIGHT = [-0.58, 0.81];

// Straight-alpha RGBA of the point `p`: the outline graphite and opaque, the glass rim pale and
// lit on its upper left, the lens a faint frost with a highlight along its upper-left edge.
function shade(p, shape) {
	const [sil, lens] = glass2(p, shape);
	if (sil > 0) return [0, 0, 0, 0];
	if (lens >= 0 && lens <= LINE) return [22, 24, 30, 1];
	const e = 0.002;
	const n = [glass2([p[0] + e, p[1]], shape)[1] - lens, glass2([p[0], p[1] + e], shape)[1] - lens];
	const lit = clamp01(0.5 + (0.5 * dot(n, LIGHT)) / (Math.hypot(n[0], n[1]) || 1));
	if (lens > LINE) return [244, 248, 255, 0.5 + 0.4 * lit];
	const glow = Math.exp(lens / 0.03) * (1 - lit);
	return [236, 242, 252, 0.28 + 0.35 * glow + 0.12 * clamp01(-p[1] * 1.2)];
}

// The model box (x0, x1, top) at the sprite's full height, centred across it.
function render(shape) {
	const [x0, x1, top] = box(shape === "arrow" ? "BOX_GLASS_ARROW" : "BOX_GLASS_HAND");
	const scale = SPRITE * SCULPT_SCALE;
	const left = (SPRITE - (x1 - x0) * scale) / 2;
	const rgba = Buffer.alloc(SPRITE * SPRITE * 4);
	for (let y = 0; y < SPRITE; y++) {
		for (let x = 0; x < SPRITE; x++) {
			const acc = [0, 0, 0, 0];
			for (let sy = 0; sy < SS; sy++) {
				for (let sx = 0; sx < SS; sx++) {
					const p = [
						x0 + (x + (sx + 0.5) / SS - left) / scale,
						top - (y + (sy + 0.5) / SS) / scale,
					];
					const [r, g, b, a] = shade(p, shape);
					acc[0] += r * a;
					acc[1] += g * a;
					acc[2] += b * a;
					acc[3] += a;
				}
			}
			const a = acc[3] / (SS * SS);
			const i = (y * SPRITE + x) * 4;
			if (a > 0)
				rgba.set([...acc.slice(0, 3).map((c) => Math.round(c / acc[3])), Math.round(a * 255)], i);
		}
	}
	// The hotspot, the prototype origin, in the 32-pixel reference of cursorThemes.ts.
	const hotspot = [(left - x0 * scale) / 4, (top * scale) / 4];
	return { rgba, hotspot };
}

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

await mkdir(OUT, { recursive: true });
for (const shape of ["arrow", "pointer"]) {
	const { rgba, hotspot } = render(shape);
	await writeFile(path.join(OUT, `${shape}.png`), png(SPRITE, SPRITE, rgba));
	console.log(`${shape}: hotspotX ${hotspot[0].toFixed(4)}, hotspotY ${hotspot[1].toFixed(4)}`);
}
