import { useEffect, useState } from "react";
import type { TranscriptionSettingsSnapshot } from "../../electron/stt/settingsContract";

export const TRANSCRIPTION_SETTINGS_CHANGED_EVENT = "openscreen:transcription-settings-changed";

/** Read only the public settings snapshot; unknown providers must not imply local-only privacy. */
export function useTranscriptionProvider(
	isTranscribing: boolean,
): TranscriptionSettingsSnapshot | null {
	const api = typeof window === "undefined" ? undefined : window.electronAPI?.stt;
	const [snapshot, setSnapshot] = useState<TranscriptionSettingsSnapshot | null>(null);
	// biome-ignore lint/correctness/useExhaustiveDependencies: Starting or ending transcription invalidates the public provider snapshot.
	useEffect(() => {
		let current = true;
		let revision = 0;
		const refresh = () => {
			const requested = ++revision;
			setSnapshot(null);
			if (!api?.getSettings) return;
			void api.getSettings().then(
				(next) => {
					if (current && requested === revision) setSnapshot(next);
				},
				() => {
					if (current && requested === revision) setSnapshot(null);
				},
			);
		};
		refresh();
		window.addEventListener(TRANSCRIPTION_SETTINGS_CHANGED_EVENT, refresh);
		window.addEventListener("focus", refresh);
		return () => {
			current = false;
			window.removeEventListener(TRANSCRIPTION_SETTINGS_CHANGED_EVENT, refresh);
			window.removeEventListener("focus", refresh);
		};
	}, [api, isTranscribing]);
	return snapshot;
}
