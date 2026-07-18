import type { Rectangle } from "electron";

export interface CursorRecordingTarget {
	displayId: number | null;
	getDisplayBounds: () => Rectangle | null;
	sourceId: string | null;
}

/**
 * Keep one source snapshot authoritative for the whole cursor session. Mixing
 * fields from a newly requested source with the previously selected source can
 * normalize cursor telemetry against the wrong monitor or window.
 */
export function resolveCursorRecordingTarget(
	explicitTarget: CursorRecordingTarget | undefined,
	selectedTarget: CursorRecordingTarget,
): CursorRecordingTarget {
	return explicitTarget ?? selectedTarget;
}
