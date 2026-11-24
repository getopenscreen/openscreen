import { useCallback, useEffect, useRef, useState } from "react";
import { DEFAULT_WEBCAM_ROUNDNESS } from "../lib/projectDefaults";

/** Device settings' preview shapes: the camera's whole frame, or a rounded square crop. */
export type CameraPreviewShape = "default" | "square";

type StoredLook = { camShape: "square" | null; camRoundness: number | null };

export interface CameraLook {
	shape: CameraPreviewShape;
	/** The Custom (square) preview's rounding, 0 square to 1 round; until moved, the editor's default. */
	roundness: number;
	setShape: (shape: CameraPreviewShape) => void;
	setRoundness: (roundness: number) => void;
}

/**
 * The camera preview's shape and the Custom (square) preview's corner rounding, from the recording
 * preferences and kept in step across windows: the HUD's Device settings write them, the
 * floating preview draws them, and every window hears the main process publish the change.
 */
export function useCameraLook(): CameraLook {
	const [stored, setStored] = useState<StoredLook>({ camShape: null, camRoundness: null });

	useEffect(() => {
		let active = true;
		const take = ({ camShape, camRoundness }: StoredLook) => setStored({ camShape, camRoundness });
		void window.electronAPI
			?.getRecordingPrefs?.()
			.then((prefs) => {
				if (active) take(prefs);
			})
			.catch(() => undefined);
		const unsubscribe = window.electronAPI?.onRecordingPrefsChanged?.(take);
		return () => {
			active = false;
			unsubscribe?.();
		};
	}, []);

	// Counts edits, so a failed write only reconciles when nothing newer was picked since.
	const edits = useRef(0);
	// Shown at once, then persisted; the published snapshot that follows agrees with it. A
	// failed write publishes nothing, so this window would keep a value no other window has:
	// read the saved one back instead.
	const save = useCallback((patch: Partial<StoredLook>) => {
		const edit = ++edits.current;
		setStored((current) => ({ ...current, ...patch }));
		void window.electronAPI?.setRecordingPrefs?.(patch).catch(async (error) => {
			console.warn("Failed to persist the camera look:", error);
			const prefs = await window.electronAPI?.getRecordingPrefs?.().catch(() => undefined);
			if (prefs && edit === edits.current) {
				setStored({ camShape: prefs.camShape, camRoundness: prefs.camRoundness });
			}
		});
	}, []);
	const setShape = useCallback(
		(shape: CameraPreviewShape) => save({ camShape: shape === "square" ? "square" : null }),
		[save],
	);
	const setRoundness = useCallback((camRoundness: number) => save({ camRoundness }), [save]);

	return {
		shape: stored.camShape === "square" ? "square" : "default",
		roundness: stored.camRoundness ?? DEFAULT_WEBCAM_ROUNDNESS.square,
		setShape,
		setRoundness,
	};
}
