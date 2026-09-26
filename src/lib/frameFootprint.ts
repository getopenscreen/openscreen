import type { RecordingFrame } from "@/lib/projectDefaults";

interface Size {
	width: number;
	height: number;
}

/** Insets around the screen box: `[left, top, right, bottom]`. */
export type Insets = [number, number, number, number];

/**
 * What a frame draws around the screen AT REST (flat, unzoomed), as insets from the screen box.
 *
 * The native compositor draws the frames (`frame_geometry.rs`) outward from the screen box it is
 * given; this only measures them, for the layout that makes room for them: every layout measures
 * the padding from what the frame draws, and the block layouts line the camera up with its body
 * (`ScreenMask`).
 */
export interface FrameFootprint {
	/** The frame's body: the window chrome, or a device's front face around its screen. */
	body: Insets;
	/** Everything it draws: the body, plus what sticks out of it, the laptop's deck or the monitor's stand. */
	outer: Insets;
}

// Mirror of `frame_geometry.rs`, every length in frame units (`frameUnit`).
const WINDOW_FRAME_BAR = 0.04;
const WINDOW_FRAME_LINE = 0.0012;
const DEV_RIM = 0.0053;
/** Black glass of each device's bezel: sides and top, then bottom. */
const DEV_BEZEL = { laptop: [0.0356, 0.0409], phone: [0.014, 0.014], monitor: [0.0178, 0.0178] };
const DEV_THICKNESS = { laptop: 0.0284, phone: 0.05, monitor: 0.0284 };
const DEV_EYE_MIN = 9.6;
const PERSPECTIVE_FACTOR = 1.6;
const DEV_DECK_LEN = 1.3;
const DEV_DECK_GAP = 0.0093;
const DEV_DECK_THICK = 0.0446;
const DEV_DECK_EYE_CLEARANCE = 0.0178;
const DEV_HINGE_MIN_RAD = 1.047198;
const DEV_HINGE_MAX_RAD = 2.356194;
const DEV_NECK_W = 0.255;
const DEV_NECK_LEN = 0.177;
const DEV_FOOT_W = 0.456;
const DEV_FOOT_H = 0.0456;
const DEV_STAND_Z = 0.0219;
const DEV_FOOT_Z = 0.195;

const NO_INSETS: Insets = [0, 0, 0, 0];

/**
 * The frame unit (`frame_unit_px`): the output's short side, scaled by the share of the output
 * the screen box fills in its fuller dimension. Same unit on x and y, in the unit of `screen`
 * once `canvas` shares it.
 */
export function frameUnit(screen: Size, canvas: Size): number {
	return (
		Math.max(screen.width / canvas.width, screen.height / canvas.height) *
		Math.min(canvas.width, canvas.height)
	);
}

/** `device_deck_angle`: the laptop's deck, seen edge-on from the flat camera. */
function deckAngle(half: [number, number], chin: number, thick: number): number {
	const eye = Math.max(2 * Math.min(half[0], half[1]) * PERSPECTIVE_FACTOR, DEV_EYE_MIN);
	const h = half[1] + chin;
	const opening = Math.atan((eye + thick * 0.5) / Math.max(h - DEV_DECK_EYE_CLEARANCE, 1e-3));
	return Math.PI - Math.min(DEV_HINGE_MAX_RAD, Math.max(DEV_HINGE_MIN_RAD, opening));
}

/** The eight corners of an axis-aligned box. */
function boxCorners(lo: number[], hi: number[]): number[][] {
	return Array.from({ length: 8 }, (_, i) => [
		i & 1 ? hi[0] : lo[0],
		i & 2 ? hi[1] : lo[1],
		i & 4 ? hi[2] : lo[2],
	]);
}

/**
 * The footprint of `frame` around a screen box of size `screen`, for a frame unit `unit` in the
 * same unit; the insets come back in it too.
 *
 * A device's body is its front face, whose projection at rest IS its rect. What sticks out of it
 * goes through `DeviceView::project` at rest: the camera looks straight at the screen, the relief
 * from the model eye `DEV_EYE_MIN` units away, so a point `(x, y, z)` of the model (screen centre
 * at the origin, z toward the viewer) lands on `(x, y) · E / (E − z)`.
 */
export function frameFootprint(frame: RecordingFrame, screen: Size, unit: number): FrameFootprint {
	if (frame === "none" || !(unit > 0)) return { body: NO_INSETS, outer: NO_INSETS };
	if (frame === "window") {
		const line = WINDOW_FRAME_LINE * unit;
		const body: Insets = [line, WINDOW_FRAME_BAR * unit, line, line];
		return { body, outer: body };
	}
	const [side, bottom] = DEV_BEZEL[frame];
	const margins = [side + DEV_RIM, side + DEV_RIM, side + DEV_RIM, bottom + DEV_RIM];
	const half: [number, number] = [screen.width / (2 * unit), screen.height / (2 * unit)];
	const thick = DEV_THICKNESS[frame];
	// The body, centred on the screen: its bottom edge is where the deck hinges and the stand hangs.
	const lo = [-half[0] - margins[0], -half[1] - margins[1]];
	const hi = [half[0] + margins[2], half[1] + margins[3]];
	const extra: number[][] = [];
	if (frame === "laptop") {
		const angle = deckAngle(half, margins[3], thick);
		const [ca, sa] = [Math.cos(angle), Math.sin(angle)];
		const hinge = [hi[1], -thick * 0.5];
		for (const [x, y, z] of boxCorners(
			[lo[0], DEV_DECK_GAP, -DEV_DECK_THICK],
			[hi[0], DEV_DECK_GAP + DEV_DECK_LEN, 0],
		)) {
			extra.push([x, hinge[0] + y * ca - z * sa, hinge[1] + y * sa + z * ca]);
		}
	} else if (frame === "monitor") {
		const [y0, z0] = [hi[1], -thick * 0.5];
		extra.push(
			...boxCorners(
				[-DEV_NECK_W, y0 - 0.01, z0 - DEV_STAND_Z],
				[DEV_NECK_W, y0 + DEV_NECK_LEN, z0],
			),
			...boxCorners(
				[-DEV_FOOT_W, y0 + DEV_NECK_LEN - 0.01, z0 - DEV_FOOT_Z],
				[DEV_FOOT_W, y0 + DEV_NECK_LEN + DEV_FOOT_H, z0],
			),
		);
	}
	const outer = [...lo, ...hi];
	for (const [x, y, z] of extra) {
		const k = DEV_EYE_MIN / (DEV_EYE_MIN - z);
		outer[0] = Math.min(outer[0], x * k);
		outer[1] = Math.min(outer[1], y * k);
		outer[2] = Math.max(outer[2], x * k);
		outer[3] = Math.max(outer[3], y * k);
	}
	return {
		body: margins.map((m) => m * unit) as Insets,
		outer: [
			(-outer[0] - half[0]) * unit,
			(-outer[1] - half[1]) * unit,
			(outer[2] - half[0]) * unit,
			(outer[3] - half[1]) * unit,
		],
	};
}
