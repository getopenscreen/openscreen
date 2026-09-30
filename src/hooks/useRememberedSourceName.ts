import { useEffect, useState } from "react";

/**
 * The name of the source picked last time, for a surface that has no live source.
 *
 * Only Apple's picker (macOS 15.2+) answers with a name: its pick cannot be restored after a
 * relaunch, so the main process keeps the name and the selection stays empty. Everywhere else
 * this is `null` and the source restores itself.
 *
 * Asked again whenever the live source goes away, because the name is written when the pick
 * is made, after this surface has already mounted.
 */
export function useRememberedSourceName(hasLiveSource: boolean): string | null {
	const [name, setName] = useState<string | null>(null);

	useEffect(() => {
		if (hasLiveSource) {
			return;
		}
		let active = true;
		void window.electronAPI
			?.getLastPickedSource?.()
			.then((next) => {
				if (active) {
					setName(next ?? null);
				}
			})
			.catch(() => undefined);
		return () => {
			active = false;
		};
	}, [hasLiveSource]);

	return name;
}
