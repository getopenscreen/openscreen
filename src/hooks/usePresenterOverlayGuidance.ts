import { useCallback, useEffect, useState } from "react";
import { loadUserPreferences, saveUserPreferences } from "@/lib/userPreferences";

/**
 * The one-time Presenter Overlay guidance acknowledgement.
 *
 * The HUD and the editor record page share the preference through localStorage.
 * A storage event is the cross-window signal: if one surface writes the
 * acknowledgement, an already mounted surface updates instead of keeping stale
 * guidance on screen. The write itself also updates this window's state, since
 * a storage event is never delivered to the window that made the change.
 */
export function usePresenterOverlayGuidance() {
	const [acknowledged, setAcknowledged] = useState(
		() => loadUserPreferences().presenterOverlayGuidanceAcknowledged,
	);

	useEffect(() => {
		const sync = () => {
			setAcknowledged(loadUserPreferences().presenterOverlayGuidanceAcknowledged);
		};
		window.addEventListener("storage", sync);
		return () => window.removeEventListener("storage", sync);
	}, []);

	const acknowledge = useCallback(() => {
		saveUserPreferences({ presenterOverlayGuidanceAcknowledged: true });
		setAcknowledged(true);
	}, []);

	return { acknowledged, acknowledge };
}
