import type { AiEditionEditStatus } from "@/native/contracts";
import type { AxcutDocument } from "../schema";
import { ensureDocument } from "../schema";
import { useProjectStore, waitForDocumentSaves } from "./projectStore";

export type AgentDocumentApplyResult = "applied" | "conflict" | "save-failed" | "no-live-document";

/**
 * Apply a full document returned by the agent only if the live editor is still
 * on the revision used to start that agent turn.
 *
 * `expectedRevision` is omitted only for explicit rewind operations, where
 * replacing the current project is the action the user confirmed.
 */
export async function applyAgentDocumentIfCurrent(
	document: unknown,
	expectedRevision?: number,
): Promise<AgentDocumentApplyResult> {
	// A manual save may have started before approval without updating the store
	// yet. Let it settle, then compare against the revision the agent saw.
	if ((await waitForDocumentSaves()) !== "idle") return "save-failed";
	const store = useProjectStore.getState();
	if (expectedRevision !== undefined && store.revision !== expectedRevision) {
		return "conflict";
	}

	const parsed = ensureDocument(document);
	// `saveDocument` updates the live store and records one history entry only
	// after the native save succeeds. Keeping the proposal off screen while the
	// save is in flight also makes failure and discard truly leave no project edit.
	if (await store.saveDocument(parsed, { history: true })) {
		return "applied";
	}
	return "save-failed";
}

export interface AgentTurn<T> {
	result: T;
	/**
	 * Apply this turn's document, if it produced one, against the revision the agent
	 * was actually given. A review cannot bypass that revision guard.
	 */
	applyDocument: () => Promise<AgentDocumentApplyResult>;
}

/** One turn-level proposal. A successful tool call is not a saved project edit. */
export interface AgentEditReview {
	status: AiEditionEditStatus;
	readonly applying: boolean;
	apply: () => Promise<AiEditionEditStatus>;
	discard: () => AiEditionEditStatus;
}

export function createAgentEditReview(
	applyDocument: AgentTurn<{
		document?: unknown;
	}>["applyDocument"],
): AgentEditReview {
	let inFlight: Promise<AiEditionEditStatus> | null = null;
	const review: AgentEditReview = {
		status: "proposed",
		get applying() {
			return inFlight !== null && review.status === "proposed";
		},
		apply() {
			if (inFlight) return inFlight;
			if (review.status !== "proposed") return Promise.resolve(review.status);
			inFlight = (async () => {
				try {
					const result = await applyDocument();
					review.status =
						result === "applied" ? "applied" : result === "conflict" ? "conflict" : "failed";
				} catch {
					review.status = "failed";
				}
				return review.status;
			})();
			return inFlight;
		},
		discard() {
			if (review.status === "proposed" && !inFlight) review.status = "discarded";
			return review.status;
		},
	};
	return review;
}

/**
 * Run one agent turn against the live document and hand back a way to apply its result.
 *
 * This exists to make the ordering structural. The guard is only worth anything if the
 * revision is the one the agent was handed, read from the SAME store snapshot as the
 * document and BEFORE the turn is awaited -- and none of that is visible at the call
 * site, where the read and the `await` are twenty lines apart in a 2,000-line component.
 * Moving the read below the await leaves every assertion about the guard passing while
 * the bug is fully restored. In here it is three adjacent lines, and a test can hold a
 * turn open, edit the store underneath it, and watch the apply refuse.
 */
export async function runAgentTurn<T extends { document?: unknown }>(
	run: (documentSnapshot: AxcutDocument | undefined) => Promise<T>,
): Promise<AgentTurn<T>> {
	const { document, revision } = useProjectStore.getState();
	// Tool implementations work on this detached copy. Even an accidental in-place
	// mutation in a future tool cannot alter the live project before approval.
	const snapshot = document ? structuredClone(document) : undefined;
	const result = await run(snapshot);
	return {
		result,
		applyDocument: async () => {
			// No document open means the agent ran text-only, against an empty stand-in that
			// still carries the real project id. If it edited that and the revision happened
			// to match, applying would write a near-empty document over a real project.
			if (!snapshot) return "no-live-document";
			return applyAgentDocumentIfCurrent(result.document, revision);
		},
	};
}
