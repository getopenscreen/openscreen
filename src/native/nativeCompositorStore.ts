/**
 * Petit store global de la vue native active. `NativeCompositorOverlay` crée la vue et
 * enregistre son id ici ; n'importe quel contrôle (inspector, transport…) peut alors
 * pousser un paramètre via `setNativeParam` sans connaître l'overlay. No-op tant qu'aucune
 * vue n'est active (flag `VITE_NATIVE_COMPOSITOR` off ou addon absent).
 */
import { setCompositorParam } from "./compositorViewClient";
import type { CompositorParamValue } from "./contracts";

let currentViewId: number | null = null;
const listeners = new Set<() => void>();

/** Appelé par l'overlay quand la vue native est créée (id) ou détruite (null). */
export function setCurrentNativeViewId(id: number | null): void {
	if (currentViewId === id) {
		return;
	}
	currentViewId = id;
	for (const l of listeners) {
		l();
	}
}

export function getCurrentNativeViewId(): number | null {
	return currentViewId;
}

/** True quand une vue native est montée — pour n'appeler `setNativeParam` que si utile. */
export function isNativeCompositorActive(): boolean {
	return currentViewId !== null;
}

/** Pousse un paramètre à la vue native active (no-op si aucune). Erreurs avalées. */
export function setNativeParam(key: string, value: CompositorParamValue): void {
	if (currentViewId === null) {
		return;
	}
	setCompositorParam(currentViewId, key, value).catch((error: unknown) => {
		console.warn(`[compositor-view] setNativeParam(${key}) failed:`, error);
	});
}

/** S'abonner à l'activité de la vue native (React: via useSyncExternalStore). */
export function subscribeNativeCompositor(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}
