// Le métrage dans la dernière image de l'aperçu natif (`FootageQuad`), que chaque image du
// compositeur porte avec ses pixels. Le gimbal d'un flou de confidentialité s'y pose : là où le
// compositeur peint le masque, sous un zoom comme sous la 3D.

import { useSyncExternalStore } from "react";
import { type FootageQuad, quadFromPacket } from "@/lib/ai-edition/annotations/footageQuad";

let current: FootageQuad | null = null;
let currentKey = "";
const listeners = new Set<() => void>();

/** Retient le métrage d'une image livrée. Ne réveille ses lecteurs que s'il a bougé : en pause,
 *  les images se suivent à l'identique. `null` l'oublie (vue détruite). */
export function publishFootageQuad(
	footage: readonly number[] | null | undefined,
	projective?: boolean,
): void {
	const next = quadFromPacket(footage, projective);
	const key = next ? `${next.projective}:${next.corners.flat().join(",")}` : "";
	if (key === currentKey) return;
	currentKey = key;
	current = next;
	for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

/** Le métrage de la dernière image livrée ; `null` avant la première. */
export function useFootageQuad(): FootageQuad | null {
	return useSyncExternalStore(
		subscribe,
		() => current,
		() => null,
	);
}
