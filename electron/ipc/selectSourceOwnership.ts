export type SelectedSourceSnapshot = {
	name: string;
	id?: string;
	display_id?: string;
};

export type SelectSourceContext<TLive extends { id: string; name: string; display_id: string }> = {
	generation: { value: number };
	getSelected: () => { source: SelectedSourceSnapshot | null; live: TLive | null };
	setSelected: (source: SelectedSourceSnapshot | null, live: TLive | null) => void;
	getCached: (id: string) => TLive | null;
	replaceCache: (sources: TLive[]) => void;
};

export type SelectSourceDeps<TLive extends { id: string; name: string; display_id: string }> = {
	getSources: () => Promise<TLive[]>;
	persist: (source: SelectedSourceSnapshot) => void;
	broadcast: (source: SelectedSourceSnapshot | null) => void;
	shouldPersist: (options?: { persist?: boolean }) => boolean;
};

export function bumpSelectSourceGeneration(generation: { value: number }): number {
	generation.value += 1;
	return generation.value;
}

export async function selectSourceWithOwnership<
	TLive extends { id: string; name: string; display_id: string },
>(
	ctx: SelectSourceContext<TLive>,
	source: { id?: string; name: string; display_id?: string },
	options: { persist?: boolean } | undefined,
	deps: SelectSourceDeps<TLive>,
): Promise<SelectedSourceSnapshot | null> {
	const generation = bumpSelectSourceGeneration(ctx.generation);
	let live: TLive | null = typeof source.id === "string" ? ctx.getCached(source.id) : null;

	if (!live && typeof source.id === "string") {
		try {
			const sources = await deps.getSources();
			if (generation !== ctx.generation.value) {
				return ctx.getSelected().source;
			}
			ctx.replaceCache(sources);
			live = ctx.getCached(source.id);
		} catch {
			if (generation !== ctx.generation.value) {
				return ctx.getSelected().source;
			}
			live = null;
		}
	}

	if (generation !== ctx.generation.value) {
		return ctx.getSelected().source;
	}

	if (!live) {
		ctx.setSelected(null, null);
		deps.broadcast(null);
		return null;
	}

	const next: SelectedSourceSnapshot = {
		id: live.id,
		name: live.name,
		display_id: live.display_id,
	};
	ctx.setSelected(next, live);
	if (deps.shouldPersist(options)) {
		try {
			deps.persist(next);
		} catch (error) {
			console.warn("Failed to persist the selected recording source:", error);
		}
	}
	deps.broadcast(next);
	return next;
}
