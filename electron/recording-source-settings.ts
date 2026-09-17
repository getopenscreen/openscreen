import type { RecordingSourceDescriptor } from "./app-settings";

export interface LiveRecordingSource {
	id: string;
	name: string;
	display_id: string;
}

export function recordingSourceKindFromId(id: string): RecordingSourceDescriptor["kind"] {
	return id.startsWith("window:") ? "window" : "screen";
}

export function describeRecordingSource(
	platform: NodeJS.Platform,
	source: LiveRecordingSource,
): RecordingSourceDescriptor {
	return {
		platform,
		kind: recordingSourceKindFromId(source.id),
		id: source.id,
		name: source.name,
		displayId: source.display_id || null,
	};
}

/**
 * A screen-only (or window-only) enumeration cannot prove a source of the
 * other kind is gone. Clearing the live pick in that case is a false negative.
 */
export function enumerationIncludesSourceKind(
	requestedTypes: readonly string[] | undefined,
	sourceId: string | null | undefined,
): boolean {
	if (!sourceId) return true;
	const types = requestedTypes && requestedTypes.length > 0 ? requestedTypes : ["screen", "window"];
	return types.includes(recordingSourceKindFromId(sourceId));
}

export function mergeEnumeratedSources<T extends { id: string }>(
	previous: ReadonlyMap<string, T>,
	next: readonly T[],
	requestedTypes: readonly string[] | undefined,
): Map<string, T> {
	const types = requestedTypes && requestedTypes.length > 0 ? requestedTypes : ["screen", "window"];
	const merged = new Map(previous);
	for (const id of [...merged.keys()]) {
		if (types.includes(recordingSourceKindFromId(id))) {
			merged.delete(id);
		}
	}
	for (const source of next) {
		merged.set(source.id, source);
	}
	return merged;
}

/** HUD/RecStage persist the pick; CLI capture must not overwrite that default. */
export function shouldPersistSelectedSource(options?: { persist?: boolean }): boolean {
	return options?.persist !== false;
}

export function sameRecordingSourceDescriptor(
	left: RecordingSourceDescriptor | null | undefined,
	right: RecordingSourceDescriptor | null | undefined,
): boolean {
	if (left == null && right == null) return true;
	if (left == null || right == null) return false;
	return (
		left.platform === right.platform &&
		left.kind === right.kind &&
		left.id === right.id &&
		left.name === right.name &&
		left.displayId === right.displayId
	);
}

/**
 * Drop a restore result when the live selection or the persisted descriptor
 * changed while enumeration was in flight. This includes reset: both sides can
 * still be null while lastSource went from A to empty.
 */
export function shouldCommitRestoredRecordingSource(options: {
	selectedBeforeId?: string | null;
	selectedAfterId?: string | null;
	lastSourceBefore: RecordingSourceDescriptor | null | undefined;
	lastSourceAfter: RecordingSourceDescriptor | null | undefined;
}): boolean {
	return (
		(options.selectedBeforeId ?? null) === (options.selectedAfterId ?? null) &&
		sameRecordingSourceDescriptor(options.lastSourceBefore, options.lastSourceAfter)
	);
}

export function restoreRecordingSourceAfterEnumeration(options: {
	selectedBefore: LiveRecordingSource | null | undefined;
	selectedAfter: LiveRecordingSource | null | undefined;
	lastSourceBefore: RecordingSourceDescriptor | null | undefined;
	lastSourceAfter: RecordingSourceDescriptor | null | undefined;
	platform: NodeJS.Platform;
	sources: readonly LiveRecordingSource[];
}): { apply: boolean; restored: LiveRecordingSource | null } {
	if (
		!shouldCommitRestoredRecordingSource({
			selectedBeforeId: options.selectedBefore?.id,
			selectedAfterId: options.selectedAfter?.id,
			lastSourceBefore: options.lastSourceBefore,
			lastSourceAfter: options.lastSourceAfter,
		})
	) {
		return { apply: false, restored: null };
	}
	return {
		apply: true,
		restored: resolveCurrentRecordingSource(
			options.selectedBefore,
			options.lastSourceBefore,
			options.platform,
			options.sources,
		),
	};
}

/** True when restoration or liveness checking has a source to look up. */
export function shouldEnumerateRecordingSources(
	selected: LiveRecordingSource | null | undefined,
	lastSource: RecordingSourceDescriptor | null | undefined,
): boolean {
	return Boolean(selected?.id || lastSource);
}

/**
 * In-memory selections stay bound to the live id: a browser tab or document title
 * can change without the window going away. Disk restore stays strict.
 */
export function resolveLiveRecordingSource(
	selected: LiveRecordingSource,
	sources: readonly LiveRecordingSource[],
): LiveRecordingSource | null {
	const exact = sources.filter((source) => source.id === selected.id);
	return exact.length === 1 ? exact[0] : null;
}

export function resolveCurrentRecordingSource(
	selected: LiveRecordingSource | null | undefined,
	lastSource: RecordingSourceDescriptor | null | undefined,
	platform: NodeJS.Platform,
	sources: readonly LiveRecordingSource[],
	options: { waylandPortal?: boolean } = {},
): LiveRecordingSource | null {
	if (selected?.id) {
		return resolveLiveRecordingSource(selected, sources);
	}
	return resolveRecordingSource(lastSource ?? null, platform, sources, options);
}

/** Resolves a stored logical descriptor only to an item from a fresh enumeration. */
export function resolveRecordingSource(
	descriptor: RecordingSourceDescriptor | null,
	platform: NodeJS.Platform,
	sources: readonly LiveRecordingSource[],
	options: { waylandPortal?: boolean } = {},
): LiveRecordingSource | null {
	if (!descriptor || descriptor.platform !== platform || options.waylandPortal) return null;
	const kindMatches = sources.filter(
		(source) => (source.id.startsWith("window:") ? "window" : "screen") === descriptor.kind,
	);
	if (descriptor.kind === "window") {
		const exact = kindMatches.filter(
			(source) => source.id === descriptor.id && source.name === descriptor.name,
		);
		return exact.length === 1 ? exact[0] : null;
	}

	if (descriptor.displayId) {
		const stable = kindMatches.filter((source) => source.display_id === descriptor.displayId);
		if (stable.length === 1) return stable[0];
	}
	const exact = kindMatches.filter(
		(source) => source.id === descriptor.id && source.name === descriptor.name,
	);
	return exact.length === 1 ? exact[0] : null;
}
