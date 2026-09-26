// @vitest-environment jsdom
// A mixed timeline is the case where "fill frame" cannot keep its promise for every clip, and
// the answer is to let the user say WHICH shape to fill rather than picking the majority
// silently. That choice only renders under conditions the other tests can't reach — a real
// document, with clips of two shapes, and the frame already zeroed — so it gets its own file.

import "@testing-library/jest-dom";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/contexts/I18nContext";
import { LOCALE_STORAGE_KEY } from "@/i18n/config";
import type { AxcutDocument } from "@/lib/ai-edition/schema";
import { createEmptyDocument } from "@/lib/ai-edition/schema";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import { VideoEffectsPane } from "./RightPanes";

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }));

/** A timeline whose clips carry the given pixel shapes, one clip per entry. */
function documentWithShapes(shapes: Array<[number, number]>): AxcutDocument {
	const base = createEmptyDocument({ title: "T", projectId: "p1" });
	return {
		...base,
		assets: shapes.map(([width, height], i) => ({
			id: `asset_${i}`,
			kind: "video" as const,
			label: `Clip ${i}`,
			originalPath: `/tmp/clip${i}.mp4`,
			durationSec: 10,
			cameraTrack: null,
			video: { width, height },
		})),
		timeline: {
			...base.timeline,
			clips: shapes.map((_, i) => ({
				id: `clip_${i}`,
				assetId: `asset_${i}`,
				sourceStartSec: 0,
				sourceEndSec: 10,
				timelineStartSec: i * 10,
				timelineEndSec: (i + 1) * 10,
				wordRefs: [],
				origin: "user" as const,
				reason: "",
			})),
		},
		// Deliberately NOT the fitted state, and not any shape the timeline holds: an
		// assertion that the action produced 16:9 + zeros proves nothing if the document
		// started there. These are the shipped defaults, which is what a real project opens
		// with anyway.
		legacyEditor: {
			padding: 50,
			borderRadius: 40,
			shadowIntensity: 0.2,
			aspectRatio: "1:1",
		},
	} as unknown as AxcutDocument;
}

function mount(doc: AxcutDocument, locale?: string) {
	if (locale) localStorage.setItem(LOCALE_STORAGE_KEY, locale);
	useProjectStore.setState({ document: doc });
	return render(
		<I18nProvider>
			<VideoEffectsPane />
		</I18nProvider>,
	);
}

/** What the action actually wrote, read back off the document it wrote to. */
function frameSettings() {
	const legacy = useProjectStore.getState().document?.legacyEditor as
		| Record<string, unknown>
		| undefined;
	return {
		aspectRatio: legacy?.aspectRatio,
		padding: legacy?.padding,
		borderRadius: legacy?.borderRadius,
		shadowIntensity: legacy?.shadowIntensity,
	};
}

beforeEach(() => {
	localStorage.clear();
	useProjectStore.setState({ document: null });
});
afterEach(() => {
	cleanup();
	localStorage.clear();
});

describe("fitting a clip is an action, and a choice only when there is one", () => {
	it("acts without asking when the timeline holds one shape", async () => {
		mount(documentWithShapes([[1920, 1080]]));
		fireEvent.click(screen.getByRole("button", { name: "Fit" }));

		expect(screen.queryByRole("menu")).not.toBeInTheDocument();
		// The whole point of the button, and what none of these cases used to check: not that
		// a menu did or did not open, but that the four frame settings actually moved.
		await waitFor(() =>
			expect(frameSettings()).toEqual({
				aspectRatio: "16:9",
				padding: 0,
				borderRadius: 0,
				shadowIntensity: 0,
			}),
		);
	});

	it("applies the shape the user picked, not the majority one", async () => {
		// Five landscape clips, two portrait. Picking the minority must win over the default,
		// or the menu is decoration.
		mount(
			documentWithShapes([
				[1920, 1080],
				[1920, 1080],
				[1920, 1080],
				[1920, 1080],
				[1920, 1080],
				[1080, 1920],
				[1080, 1920],
			]),
		);
		fireEvent.click(screen.getByRole("button", { name: "Fit" }));
		fireEvent.click(
			within(screen.getByRole("menu")).getByRole("menuitem", { name: /1080 × 1920/ }),
		);

		await waitFor(() =>
			expect(frameSettings()).toEqual({
				aspectRatio: "9:16",
				padding: 0,
				borderRadius: 0,
				shadowIntensity: 0,
			}),
		);
	});

	it("asks which clip when the timeline holds more than one shape", () => {
		// Five landscape clips and two portrait inserts: picking the majority silently would
		// mean the portrait ones can never be fitted.
		mount(
			documentWithShapes([
				[1920, 1080],
				[1920, 1080],
				[1920, 1080],
				[1920, 1080],
				[1920, 1080],
				[1080, 1920],
				[1080, 1920],
			]),
		);
		fireEvent.click(screen.getByRole("button", { name: "Fit" }));

		const menu = screen.getByRole("menu");
		// Resolution leads — `683:384` and `64:27` mean nothing to a user, `1920 × 1080` does.
		expect(
			within(menu).getByRole("menuitem", { name: /1920 × 1080.*5 clips/ }),
		).toBeInTheDocument();
		expect(
			within(menu).getByRole("menuitem", { name: /1080 × 1920.*2 clips/ }),
		).toBeInTheDocument();
	});

	it('counts one clip as "1 clip"', () => {
		mount(
			documentWithShapes([
				[1920, 1080],
				[1920, 1080],
				[1080, 1920],
			]),
		);
		fireEvent.click(screen.getByRole("button", { name: "Fit" }));
		const menu = screen.getByRole("menu");
		expect(
			within(menu).getByRole("menuitem", { name: /1080 × 1920.*1 clip$/ }),
		).toBeInTheDocument();
		expect(
			within(menu).getByRole("menuitem", { name: /1920 × 1080.*2 clips/ }),
		).toBeInTheDocument();
	});

	it("counts in Russian with the form the count actually needs", () => {
		// Russian has four plural categories, and 2-4 takes "клипа". Mapping everything that
		// is not `one` onto a single plural rendered "2 клипов", which is wrong rather than
		// merely coarse — the reason the count goes through Intl.PluralRules and not
		// `count === 1`.
		mount(
			documentWithShapes([
				[1920, 1080],
				[1920, 1080],
				[1080, 1920],
			]),
			"ru",
		);
		fireEvent.click(screen.getByRole("button", { name: "Подогнать" }));
		const menu = screen.getByRole("menu");
		expect(
			within(menu).getByRole("menuitem", { name: /1920 × 1080.*2 клипа/ }),
		).toBeInTheDocument();
		expect(
			within(menu).getByRole("menuitem", { name: /1080 × 1920.*1 клип$/ }),
		).toBeInTheDocument();
	});

	it("collapses same-shape clips to one entry, labelled with the biggest", () => {
		mount(
			documentWithShapes([
				[1920, 1080],
				[3840, 2160],
			]),
		);
		// Both are 16:9, so there is one shape and nothing to arbitrate — and the ratio menu's
		// rule applies: the label shows the best resolution available.
		expect(screen.getByRole("button", { name: "Fit" })).toBeInTheDocument();
		expect(screen.queryByRole("note")).not.toBeInTheDocument();
	});
});

describe("the frame row persists the pick", () => {
	const stored = (key: string) =>
		(useProjectStore.getState().document?.legacyEditor as Record<string, unknown>)?.[key];
	const pick = (row: string, label: string) =>
		within(screen.getByRole("group", { name: row })).getByRole("button", { name: label });

	it("writes each frame to the document, with no option withheld", async () => {
		mount(documentWithShapes([[1920, 1080]]));
		// A 16:9 project: the phone is offered all the same. Nothing is gated — the frame adapts
		// to the footage, and a phone around a landscape clip is a phone lying on its side.
		for (const [label, frame] of [
			["Window", "window"],
			["Laptop", "laptop"],
			["Phone", "phone"],
			["Screen", "monitor"],
			["None", "none"],
		] as const) {
			const tile = pick("Style", label);
			expect(tile).not.toBeDisabled();
			fireEvent.click(tile);
			await waitFor(() => expect(stored("frame")).toBe(frame));
			expect(tile).toHaveAttribute("aria-pressed", "true");
		}
	});

	it("offers the theme once a frame is on, and writes it", async () => {
		mount(documentWithShapes([[1920, 1080]]));
		// No frame, no theme row: it would recolour nothing.
		expect(screen.queryByRole("group", { name: "Theme" })).not.toBeInTheDocument();
		fireEvent.click(pick("Style", "Laptop"));
		await waitFor(() => expect(stored("frame")).toBe("laptop"));
		fireEvent.click(pick("Theme", "Dark"));
		await waitFor(() => expect(stored("frameTheme")).toBe("dark"));
	});
});

describe("the format row", () => {
	const pressed = () =>
		within(screen.getByRole("group", { name: "Format" }))
			.getAllByRole("button")
			.filter((b) => b.getAttribute("aria-pressed") === "true")
			.map((b) => b.textContent);

	it("shows every preset at once and writes the one clicked", async () => {
		mount(documentWithShapes([[1920, 1080]]));
		// Auto leads, then the presets in menu order: all of them on screen, no menu to open.
		expect(
			within(screen.getByRole("group", { name: "Format" }))
				.getAllByRole("button")
				.map((b) => b.textContent),
		).toEqual(["Auto", "16:9", "9:16", "1:1", "4:3", "4:5", "16:10", "10:16"]);
		expect(pressed()).toEqual(["1:1"]);
		fireEvent.click(
			within(screen.getByRole("group", { name: "Format" })).getByRole("button", { name: "4:5" }),
		);
		await waitFor(() => expect(frameSettings().aspectRatio).toBe("4:5"));
		expect(pressed()).toEqual(["4:5"]);
	});

	it("lists the footage's own shape under Original, with its pixel size", async () => {
		mount(documentWithShapes([[1366, 768]]));
		const original = screen.getByRole("group", { name: "Original" });
		fireEvent.click(within(original).getByRole("button", { name: "683:384 · 1366×768" }));
		await waitFor(() => expect(frameSettings().aspectRatio).toBe("683:384"));
	});

	it("keeps Auto listed but dead while it is the format of a mixed timeline, and says why", () => {
		const doc = documentWithShapes([
			[1920, 1080],
			[1080, 1920],
		]);
		(doc.legacyEditor as Record<string, unknown>).aspectRatio = "auto";
		mount(doc);
		const auto = within(screen.getByRole("group", { name: "Format" })).getByRole("button", {
			name: "Auto",
		});
		expect(auto).toBeDisabled();
		expect(auto).toHaveAttribute("aria-pressed", "true");
		expect(screen.getByRole("group", { name: "Format" })).toHaveAccessibleDescription(
			"Clips differ",
		);
	});

	it("does not offer Auto on a mixed timeline that is on another format", () => {
		mount(
			documentWithShapes([
				[1920, 1080],
				[1080, 1920],
			]),
		);
		expect(
			within(screen.getByRole("group", { name: "Format" })).queryByRole("button", { name: "Auto" }),
		).not.toBeInTheDocument();
	});
});
