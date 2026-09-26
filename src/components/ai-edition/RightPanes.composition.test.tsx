// @vitest-environment jsdom
// The Composition pane's format and frame rows, against a real document whose clips carry real
// pixel shapes: the Original row and Auto only exist, or only die, under those conditions.

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
		// Not any shape the timeline holds, so a pick cannot pass by starting where it should
		// end. These are the shipped defaults, which is what a real project opens with anyway.
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

/** What a pick actually wrote, read back off the document it wrote to. */
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

	it("collapses same-shape clips to one Original entry, labelled with the biggest", () => {
		mount(
			documentWithShapes([
				[1920, 1080],
				[3840, 2160],
			]),
		);
		expect(
			within(screen.getByRole("group", { name: "Original" }))
				.getAllByRole("button")
				.map((b) => b.textContent),
		).toEqual(["16:9 · 3840×2160"]);
	});

	it("counts each shape's clips on hover, in the form the count needs", () => {
		// Russian has four plural categories, and 2-4 takes "клипа". Mapping everything that
		// is not `one` onto a single plural rendered "2 клипов", which is wrong rather than
		// merely coarse — the reason the count goes through Intl.PluralRules and not
		// `count === 1`.
		const titles = (locale?: string) => {
			mount(
				documentWithShapes([
					[1920, 1080],
					[1920, 1080],
					[1080, 1920],
				]),
				locale,
			);
			const read = ["16:9 · 1920×1080", "9:16 · 1080×1920"].map((name) =>
				screen.getByRole("button", { name }).getAttribute("title"),
			);
			cleanup();
			return read;
		};
		expect(titles()).toEqual(["16:9 · 1920×1080 · 2 clips", "9:16 · 1080×1920 · 1 clip"]);
		expect(titles("ru")).toEqual(["16:9 · 1920×1080 · 2 клипа", "9:16 · 1080×1920 · 1 клип"]);
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
