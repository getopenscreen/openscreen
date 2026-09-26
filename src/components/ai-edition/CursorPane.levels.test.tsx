// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/contexts/I18nContext";
import { LOCALE_STORAGE_KEY } from "@/i18n/config";
import { assetSchema, clipSchema, createEmptyDocument } from "@/lib/ai-edition/schema";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import { type NativeCursorType, nativeBridgeClient } from "@/native";
import { CursorPane } from "./RightPanes";

beforeEach(() => {
	const store = new Map<string, string>([[LOCALE_STORAGE_KEY, "en"]]);
	Object.defineProperty(globalThis, "localStorage", {
		configurable: true,
		value: {
			getItem: (key: string) => store.get(key) ?? null,
			setItem: (key: string, value: string) => void store.set(key, value),
			removeItem: (key: string) => void store.delete(key),
			clear: () => store.clear(),
			key: (i: number) => [...store.keys()][i] ?? null,
			get length() {
				return store.size;
			},
		},
	});
});

afterEach(() => {
	cleanup();
	useProjectStore.getState().clear();
});

function renderWithCursor(legacyEditor: Record<string, unknown>) {
	const document = createEmptyDocument({ projectId: "p", title: "t" });
	useProjectStore.setState({ projectId: "p", document: { ...document, legacyEditor } });
	render(
		<I18nProvider>
			<CursorPane />
		</I18nProvider>,
	);
}

const pressed = (group: string) =>
	screen.getByRole("group", { name: group }).querySelectorAll('button[aria-pressed="true"]');

describe("CursorPane named levels", () => {
	it("names the click bounce instead of showing a number", () => {
		renderWithCursor({ cursorClickBounce: 0 });
		expect([...pressed("Click bounce")].map((b) => b.textContent)).toEqual(["None"]);
	});

	it("presses nothing for a stored value between two levels", () => {
		renderWithCursor({ cursorClickBounce: 1.5 });
		expect(pressed("Click bounce")).toHaveLength(0);
	});
});

describe("CursorPane cursor types", () => {
	/** A one-clip project over a recording whose cursor walks through `states`, 100 ms each. */
	function renderWithRecording(
		legacyEditor: Record<string, unknown>,
		states: Array<NativeCursorType | null>,
	) {
		// A path per test: the pane reads each recording once per session.
		const originalPath = `/recordings/${crypto.randomUUID()}.mp4`;
		vi.spyOn(nativeBridgeClient.cursor, "getRecordingData").mockResolvedValue({
			version: 2,
			provider: "native",
			assets: [],
			samples: states.map((cursorType, i) => ({ timeMs: i * 100, cx: 0.5, cy: 0.5, cursorType })),
		});
		vi.spyOn(nativeBridgeClient.aiEdition, "save").mockImplementation(async (document) => ({
			success: true,
			document,
		}));
		const document = createEmptyDocument({ projectId: "p", title: "t" });
		const asset = assetSchema.parse({ id: "a", label: "take", originalPath });
		const clip = clipSchema.parse({
			id: "c",
			assetId: "a",
			sourceStartSec: 0,
			sourceEndSec: 10,
			timelineStartSec: 0,
			timelineEndSec: 10,
			origin: "user",
		});
		useProjectStore.setState({
			projectId: "p",
			document: {
				...document,
				assets: [asset],
				timeline: { ...document.timeline, clips: [clip] },
				legacyEditor,
			},
		});
		render(
			<I18nProvider>
				<CursorPane />
			</I18nProvider>,
		);
	}

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("offers only the cursors the video shows, lit until drawn as the arrow", async () => {
		renderWithRecording({ cursorAsArrow: ["text"] }, ["arrow", "pointer", "text", null]);
		const group = await screen.findByRole("group", { name: "Cursor types" });
		const buttons = [...group.querySelectorAll("button")];
		expect(
			buttons.map((b) => [b.getAttribute("aria-label"), b.getAttribute("aria-pressed")]),
		).toEqual([
			["Hand", "true"],
			["Text", "false"],
		]);
		// The arrow is what the others become: shown, never a switch.
		expect(within(group).getByRole("img", { name: "Arrow" }).tagName).toBe("SPAN");
	});

	it("draws a type as the arrow on a click, and as recorded on the next", async () => {
		renderWithRecording({}, ["arrow", "resize-ns", "pointer"]);
		const resize = await screen.findByRole("button", { name: "Resize" });
		fireEvent.click(resize);
		const asArrow = () => useProjectStore.getState().document?.legacyEditor?.cursorAsArrow;
		expect(asArrow()).toEqual(["resize"]);
		fireEvent.click(screen.getByRole("button", { name: "Hand" }));
		expect(asArrow()).toEqual(["pointer", "resize"]);
		fireEvent.click(screen.getByRole("button", { name: "Resize" }));
		expect(asArrow()).toEqual(["pointer"]);
	});

	it("offers nothing to redraw when the video only shows the arrow", async () => {
		renderWithRecording({}, ["arrow", null]);
		await waitFor(() => expect(nativeBridgeClient.cursor.getRecordingData).toHaveBeenCalled());
		expect(screen.queryByRole("group", { name: "Cursor types" })).toBeNull();
	});

	// The 3D switch changes how the chosen style looks, so it sits right under the styles.
	it("puts the 3D switch right under the cursor styles", () => {
		renderWithCursor({});
		const styleLabel = screen.getByText("Cursor style");
		const grid = styleLabel.nextElementSibling;
		expect(grid?.nextElementSibling?.textContent).toBe("3D cursor");
	});
});

describe("CursorPane size", () => {
	// Named steps stopped at 2.75; people asked for at least twice that.
	it("is a slider from the default up to four times it", () => {
		renderWithCursor({ cursorSize: 4.5 });
		const slider = screen.getByRole("slider", { name: "Size" }) as HTMLInputElement;
		expect([slider.min, slider.max, slider.value]).toEqual(["1.5", "6", "4.5"]);
	});
});

describe("CursorPane click impact", () => {
	const toggle = () => screen.queryByRole("button", { name: "Click impact" });

	it("is a project-wide switch, off by default", () => {
		renderWithCursor({});
		expect(toggle()?.getAttribute("aria-pressed")).toBe("false");
		fireEvent.click(toggle() as HTMLElement);
		expect(useProjectStore.getState().document?.legacyEditor).toMatchObject({
			cursorClickImpact: true,
		});
	});

	// The impact follows the pointer you see: with the cursor hidden it has nothing to show.
	it("is not offered while the cursor is hidden", () => {
		renderWithCursor({ cursorShow: false });
		expect(toggle()).toBeNull();
	});
});
