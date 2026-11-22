import {
	type AxcutCursorMotionRegion,
	type CursorMotionEasing,
	type CursorMotionMode,
	DEFAULT_CURSOR_MOTION_STRENGTH,
} from "@/lib/ai-edition/schema";

type Translate = (key: string, vars?: Record<string, string | number>) => string;

// Literal keys, one per value: `npm run i18n:check` reads keys out of the source, so a key built
// from a template would be invisible to it.
export function cursorMotionModeLabel(mode: CursorMotionMode, ts: Translate): string {
	switch (mode) {
		case "recorded":
			return ts("cursorMotion.modes.recorded");
		case "smooth":
			return ts("cursorMotion.modes.smooth");
		case "straight":
			return ts("cursorMotion.modes.straight");
		case "freeze":
			return ts("cursorMotion.modes.freeze");
	}
}

export function cursorMotionEasingLabel(easing: CursorMotionEasing, ts: Translate): string {
	switch (easing) {
		case "ease-in-out":
			return ts("cursorMotion.easings.easeInOut");
		case "linear":
			return ts("cursorMotion.easings.linear");
		case "ease-in":
			return ts("cursorMotion.easings.easeIn");
		case "ease-out":
			return ts("cursorMotion.easings.easeOut");
	}
}

/** The pill's text: the mode, and the strength when it is the one parameter that matters. */
export function cursorMotionLabel(
	region: Pick<AxcutCursorMotionRegion, "mode" | "strength">,
	ts: Translate,
): string {
	const mode = cursorMotionModeLabel(region.mode, ts);
	if (region.mode !== "smooth") return mode;
	const strength = Math.round((region.strength ?? DEFAULT_CURSOR_MOTION_STRENGTH) * 100);
	return `${mode} · ${strength}%`;
}
