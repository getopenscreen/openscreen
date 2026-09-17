// Reuse an already-imported asset over importing the same file twice.
//
// Shared by every flow that adds a file the project may already hold (a voiceover take, a
// bundled music track). Importing the same path twice is not just a duplicate row in the
// media list: `addAudioAsset` finds the asset it just added by path, so with two assets on
// one path its duration probe patches whichever came first.

import type { AxcutAsset } from "@/lib/ai-edition/schema";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";

export function findExistingAsset(path: string): AxcutAsset | null {
	const doc = useProjectStore.getState().document;
	if (!doc) return null;
	return (
		doc.assets.find((a) => a.kind === "audio" && a.originalPath === path) ??
		doc.assets.find((a) => a.originalPath === path) ??
		null
	);
}
