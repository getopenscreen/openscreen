import { describe, expect, it, vi } from "vitest";
import { type SelectSourceContext, selectSourceWithOwnership } from "./selectSourceOwnership";

type Live = { id: string; name: string; display_id: string };

function createContext() {
	let selected: {
		source: { name: string; id?: string; display_id?: string } | null;
		live: Live | null;
	} = {
		source: null,
		live: null,
	};
	let cache = new Map<string, Live>();
	const ctx: SelectSourceContext<Live> = {
		generation: { value: 0 },
		getSelected: () => selected,
		setSelected: (source, live) => {
			selected = { source, live };
		},
		getCached: (id) => cache.get(id) ?? null,
		replaceCache: (sources) => {
			cache = new Map(sources.map((source) => [source.id, source]));
		},
	};
	return {
		ctx,
		get selected() {
			return selected;
		},
		seedCache(source: Live) {
			cache.set(source.id, source);
		},
	};
}

const sourceA: Live = { id: "screen:a", name: "Display A", display_id: "1" };
const sourceB: Live = { id: "screen:b", name: "Display B", display_id: "2" };

describe("selectSourceWithOwnership", () => {
	it("keeps B when a slower A enumeration finishes later", async () => {
		const harness = createContext();
		harness.seedCache(sourceB);
		let resolveA!: (sources: Live[]) => void;
		const persist = vi.fn();
		const broadcast = vi.fn();

		const pendingA = selectSourceWithOwnership(
			harness.ctx,
			sourceA,
			{ persist: true },
			{
				getSources: () =>
					new Promise<Live[]>((resolve) => {
						resolveA = resolve;
					}),
				persist,
				broadcast,
				shouldPersist: () => true,
			},
		);

		await selectSourceWithOwnership(
			harness.ctx,
			sourceB,
			{ persist: true },
			{
				getSources: async () => [sourceA, sourceB],
				persist,
				broadcast,
				shouldPersist: () => true,
			},
		);
		expect(harness.selected.source).toMatchObject({ id: "screen:b" });
		expect(persist).toHaveBeenCalledTimes(1);
		expect(persist.mock.calls[0]?.[0]).toMatchObject({ id: "screen:b" });

		resolveA([sourceA, sourceB]);
		await pendingA;

		expect(harness.selected.source).toMatchObject({ id: "screen:b" });
		expect(persist).toHaveBeenCalledTimes(1);
		expect(broadcast).toHaveBeenLastCalledWith(expect.objectContaining({ id: "screen:b" }));
	});
});
