import {
	clampPlaybackSpeed,
	MAX_PLAYBACK_SPEED,
	MIN_PLAYBACK_SPEED,
	type PlaybackSpeed,
} from "./types";

export type CustomPlaybackSpeedInputResult =
	| { status: "empty"; draft: string }
	| { status: "too-fast"; draft: string }
	| { status: "too-slow"; draft: string }
	| { status: "valid"; draft: string; speed: PlaybackSpeed };

export function parseCustomPlaybackSpeedInput(draft: string): CustomPlaybackSpeedInputResult {
	// The field's placeholder reads "2×", so a typed "1.25x" or "1.25×" is a speed, not noise.
	// Same trailing suffix the zoom field accepts (`ZoomLevelControl`).
	const sanitized = draft
		.trim()
		.replace(/,/g, ".")
		.replace(/\s*[×x]$/i, "");
	// Number("") is 0, which would report a blank draft, or a bare "x", as too-slow.
	if (sanitized === "") {
		return { status: "empty", draft };
	}
	const normalized = Number(sanitized);

	if (!Number.isFinite(normalized)) {
		return { status: "empty", draft };
	}
	if (normalized > MAX_PLAYBACK_SPEED) {
		return { status: "too-fast", draft };
	}
	if (normalized < MIN_PLAYBACK_SPEED) {
		return { status: "too-slow", draft };
	}
	// Reuse the shared clamp rather than re-inlining its rounding rule: this
	// value feeds the native scene, and a second copy would drift the first time
	// the bounds or the 2-decimal step change.
	return { status: "valid", draft, speed: clampPlaybackSpeed(normalized) };
}
