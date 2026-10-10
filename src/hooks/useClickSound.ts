// The "mouse clicks" row in the cursor pane.
//
// The sound is a setting, not a timeline track: its hits are laid out from the take's recorded
// clicks every time a scene is built (see src/lib/ai-edition/clickSound.ts), so there is no file
// to render, no track to keep honest, and nothing that can fall behind an edit.

import { useEffect, useState } from "react";
import type { ClickCue } from "@/lib/ai-edition/clickSound";
import { clickTakeOf, ensureClickHitPaths, loadClickCues } from "@/lib/ai-edition/clickSound";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";

export function useClickSound() {
	const document = useProjectStore((s) => s.document);
	const takePath = clickTakeOf(document)?.originalPath ?? null;
	// The row is offered only once the take is known to hold clicks, and reading its cues is what
	// says so — the same one-shot read the hits come from, so switching on waits on nothing more.
	const [cues, setCues] = useState<ClickCue[] | null>(null);
	useEffect(() => {
		let current = true;
		setCues(null);
		// A take whose sidecar cannot be read answers as holding no clicks — the same answer a
		// take with none gives, so the row stays out of the pane.
		if (takePath) void loadClickCues(takePath).then((loaded) => current && setCues(loaded));
		return () => {
			current = false;
		};
	}, [takePath]);

	return {
		hasClicks: Boolean(cues?.length),
		/** Warms the two caches the sound reads — the cues, and the samples staged for the
		 *  export — the moment the user asks for it, instead of leaving the first export to race
		 *  a background read. Nothing here can fail the pane: a sample that will not stage just
		 *  means the export has no clicks in it. */
		prepare: async () => {
			const take = clickTakeOf(document)?.originalPath;
			if (!take) return;
			await Promise.all([loadClickCues(take), ensureClickHitPaths().catch(() => null)]);
		},
	};
}
