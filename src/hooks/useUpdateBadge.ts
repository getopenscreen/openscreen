import { useEffect, useState } from "react";
import type { UpdateBadge } from "../../electron/background-update";

/**
 * The update button's state, as the main process's background check found it: null hides the
 * button. Subscribed before the first read, so a badge pushed while that read is in flight is not
 * overwritten by the older answer.
 */
export function useUpdateBadge(): UpdateBadge | null {
	const [badge, setBadge] = useState<UpdateBadge | null>(null);

	useEffect(() => {
		const api = window.electronAPI;
		let pushed = false;
		const unsubscribe = api?.onUpdateBadgeChanged?.((next) => {
			pushed = true;
			setBadge(next);
		});
		void api
			?.getUpdateBadge?.()
			.then((current) => {
				if (!pushed) setBadge(current);
			})
			.catch(() => {
				// No badge is the safe answer: the button stays hidden.
			});
		return () => {
			pushed = true;
			unsubscribe?.();
		};
	}, []);

	return badge;
}
