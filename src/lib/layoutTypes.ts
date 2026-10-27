/** Shared duration for the ruler hitboxes and native layout animation. */
export const LAYOUT_TRANSITION_SECONDS = 0.2;

/** Stored preset names are shared by document authoring, the UI and the native scene. */
export const LAYOUT_PRESETS = [
	"picture-in-picture",
	"dual-frame",
	"vertical-stack",
	"camera-only",
	"no-webcam",
] as const;

export type LayoutPreset = (typeof LAYOUT_PRESETS)[number];

export interface LayoutRegion {
	id: string;
	startMs: number;
	endMs: number;
	clipId?: string;
	sourceStartSec?: number;
	sourceEndSec?: number;
	preset: LayoutPreset;
	/** Migration-only envelopes in the owning clip's SOURCE time. New edits discard them. */
	legacyCamera?: {
		basePreset: LayoutPreset;
		envelopes: Array<{ sourceStartSec: number; sourceEndSec: number }>;
	};
}

export function isLayoutPreset(value: unknown): value is LayoutPreset {
	return LAYOUT_PRESETS.some((preset) => preset === value);
}
