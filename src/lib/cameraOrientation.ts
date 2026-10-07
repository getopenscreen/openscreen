/**
 * How the webcam is laid onto the frame inside a Full Camera section.
 *
 * A camera tilted down onto a desk sees the papers upside down, so a section can turn
 * the picture 180°. Mirroring follows the project unless the section says otherwise,
 * except that a turned section un-mirrors by default: the selfie mirror that suits a
 * face would print the papers' text back to front.
 *
 * The stored fields are read through here everywhere (scene, inspector, DOM preview),
 * so a value this build does not know — a 90° from a later version — reads as "none"
 * instead of reaching the compositor.
 */
export type CameraRotation = 0 | 180;
export type CameraMirrorMode = "auto" | "on" | "off";

export interface ResolvedCameraOrientation {
	rotation: CameraRotation;
	mirror: boolean;
	/** Show the whole camera frame; the face crop/zoom does not apply. */
	fullFrame: boolean;
}

export function normalizeCameraRotation(value: unknown): CameraRotation {
	return value === 180 ? 180 : 0;
}

export function normalizeCameraMirror(value: unknown): CameraMirrorMode {
	return value === "on" || value === "off" ? value : "auto";
}

export function resolveCameraOrientation(
	region: { rotation?: unknown; mirror?: unknown } | null | undefined,
	projectMirror: boolean,
): ResolvedCameraOrientation {
	if (!region) return { rotation: 0, mirror: projectMirror, fullFrame: false };
	const rotation = normalizeCameraRotation(region.rotation);
	const mode = normalizeCameraMirror(region.mirror);
	const mirror = mode === "on" ? true : mode === "off" ? false : rotation === 0 && projectMirror;
	return { rotation, mirror, fullFrame: rotation !== 0 };
}

export function isDeskView(region: { rotation?: unknown; mirror?: unknown }): boolean {
	return (
		normalizeCameraRotation(region.rotation) === 180 &&
		normalizeCameraMirror(region.mirror) === "auto"
	);
}

/** The desk-mode label is on unless the section explicitly switched it off. */
export function showsDeskLabel(region: { deskLabel?: unknown }): boolean {
	return region.deskLabel !== false;
}
