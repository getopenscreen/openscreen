import { parseCssGradient } from "@/lib/exporter/gradientParser";
import { clamp } from "@/utils/math";

/* ---------- one colour -> a gradient that cannot clash ----------
   The user picks ONE colour and gets two stops of the same family: a small hue turn and a
   lightness step, never a harmony of unrelated hues. Lightness is held between 35% and 85%
   so neither end reaches black or white, which is what made free gradients look muddy or
   blown out behind a recording. Two stops, hex, the same shape as the curated presets. */

const ANGLE_DEG = 135;
const L_MIN = 35;
const L_MAX = 85;
const HUE_TURN = 18;
const LIGHTNESS_STEP = 12;

export function oneColorGradient(hex: string): string {
	const [h, s, l] = hexToHsl(hex);
	const from = clamp(l, L_MIN, L_MAX);
	// Step down when there is room, up otherwise: both ends stay inside the band.
	const to = from - LIGHTNESS_STEP >= L_MIN ? from - LIGHTNESS_STEP : from + LIGHTNESS_STEP;
	return `linear-gradient(${ANGLE_DEG}deg, ${hslToHex(h, s, from)}, ${hslToHex(h + HUE_TURN, s, to)})`;
}

/** The colour a gradient starts from, for the picker to show: its first stop when that is hex. */
export function gradientSeedColor(wallpaper: string): string | null {
	const first = parseCssGradient(wallpaper)?.stops[0]?.color;
	return first && /^#[0-9a-f]{6}$/i.test(first) ? first.toLowerCase() : null;
}

function hexToHsl(hex: string): [number, number, number] {
	const full = hex.length === 4 ? `#${[...hex.slice(1)].map((c) => c + c).join("")}` : hex;
	const n = Number.parseInt(full.slice(1), 16);
	const r = ((n >> 16) & 255) / 255;
	const g = ((n >> 8) & 255) / 255;
	const b = (n & 255) / 255;
	const max = Math.max(r, g, b);
	const min = Math.min(r, g, b);
	const l = (max + min) / 2;
	const d = max - min;
	if (d === 0) return [0, 0, l * 100];
	const s = d / (1 - Math.abs(2 * l - 1));
	const h =
		max === r
			? ((g - b) / d + (g < b ? 6 : 0)) * 60
			: max === g
				? ((b - r) / d + 2) * 60
				: ((r - g) / d + 4) * 60;
	return [h, s * 100, l * 100];
}

function hslToHex(h: number, s: number, l: number): string {
	const sat = s / 100;
	const lig = l / 100;
	const a = sat * Math.min(lig, 1 - lig);
	const channel = (k: number) => {
		const p = (k + h / 30) % 12;
		const v = lig - a * Math.max(-1, Math.min(p - 3, 9 - p, 1));
		return Math.round(v * 255)
			.toString(16)
			.padStart(2, "0");
	};
	return `#${channel(0)}${channel(8)}${channel(4)}`;
}
