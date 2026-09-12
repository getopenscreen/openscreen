// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/contexts/I18nContext";
import type { AxcutClip } from "@/lib/ai-edition/schema";
import { EditClipModal } from "./Modals";

function renderWithI18n(ui: ReactElement) {
	return render(<I18nProvider>{ui}</I18nProvider>);
}

/** Issue #558's example: original 2:35, keep 0:20–1:45, final 1:25. */
const CLIP: AxcutClip = {
	id: "clip_1",
	assetId: "asset_1",
	sourceStartSec: 20,
	sourceEndSec: 105,
	timelineStartSec: 0,
	timelineEndSec: 85,
	wordRefs: [],
	origin: "user",
	reason: "",
};

const ASSET = { label: "rec", durationSec: 155 };

beforeAll(() => {
	// The trim-handle drag converts pointer delta against the track width into
	// seconds. jsdom reports 0, which would make every drag a no-op.
	Object.defineProperty(HTMLElement.prototype, "clientWidth", {
		configurable: true,
		get() {
			return this.getAttribute?.("data-testid") === "edit-clip-trim-track" ? 1550 : 0;
		},
	});
});

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

function renderModal(clip: AxcutClip = CLIP) {
	return renderWithI18n(
		<EditClipModal
			open
			onClose={vi.fn()}
			clip={clip}
			assetMeta={ASSET}
			videoSources={[]}
			onApply={vi.fn()}
		/>,
	);
}

describe("EditClipModal trim duration readout (#558)", () => {
	it("shows original duration, trim range, and final duration for the selected range", () => {
		renderModal();

		expect(screen.getByTestId("edit-clip-original-duration")).toHaveTextContent("2:35.0");
		expect(screen.getByTestId("edit-clip-original-duration")).toHaveTextContent(
			"Original duration",
		);
		expect(screen.getByTestId("edit-clip-trim-range")).toHaveTextContent("0:20.0–1:45.0");
		expect(screen.getByTestId("edit-clip-trim-range")).toHaveTextContent("Trim range");
		expect(screen.getByTestId("edit-clip-final-duration")).toHaveTextContent("1:25.0");
		expect(screen.getByTestId("edit-clip-final-duration")).toHaveTextContent("Final duration");
	});

	it("updates the final duration as the start handle is dragged", () => {
		renderModal();

		fireEvent.pointerDown(screen.getByRole("button", { name: "Adjust clip start" }), {
			clientX: 0,
		});
		act(() => {
			window.dispatchEvent(new MouseEvent("pointermove", { clientX: 100 }));
		});

		expect(screen.getByTestId("edit-clip-original-duration")).toHaveTextContent("2:35.0");
		expect(screen.getByTestId("edit-clip-trim-range")).toHaveTextContent("0:30.0–1:45.0");
		expect(screen.getByTestId("edit-clip-final-duration")).toHaveTextContent("1:15.0");
	});

	it("will not pass the out-point off as the source length", () => {
		// `durationSec` is optional in the asset schema, so a document can reach
		// this dialog without one. The track still has to be drawn against
		// something that contains the selection (the out-point), but calling that
		// the original duration would claim a 2:35 source was 1:45 long.
		renderWithI18n(
			<EditClipModal
				open
				onClose={vi.fn()}
				clip={CLIP}
				assetMeta={{ label: "rec" }}
				videoSources={[]}
				onApply={vi.fn()}
			/>,
		);

		expect(screen.getByTestId("edit-clip-original-duration")).toHaveTextContent("—");
		expect(screen.getByTestId("edit-clip-original-duration")).not.toHaveTextContent("1:45.0");
		// The kept range and its length are still known, and still shown.
		expect(screen.getByTestId("edit-clip-trim-range")).toHaveTextContent("0:20.0–1:45.0");
		expect(screen.getByTestId("edit-clip-final-duration")).toHaveTextContent("1:25.0");
	});

	it("states the kept range once, in the stats row", () => {
		renderModal();

		// The range used to be printed a second time inside the selection bar, 40px
		// under the stat that now carries it. One reading of a number is enough.
		expect(screen.getAllByText("0:20.0–1:45.0")).toHaveLength(1);
	});

	it("keeps the discarded head and tail out of the pointer's way", () => {
		const { container } = renderModal();

		// The dimmed tail is painted after the selection, so it covers the end
		// handle's 6px overhang and, once the range is narrower than the handle,
		// the handle itself. jsdom does not hit-test, so this pins the property
		// rather than the grab; the grab is checked by driving the real window.
		const dimmed = [...container.querySelectorAll<HTMLElement>("div")].filter(
			(el) => el.style.background === "var(--overlay-dark)",
		);
		expect(dimmed).toHaveLength(2);
		for (const el of dimmed) expect(el.style.pointerEvents).toBe("none");
	});

	it("updates the final duration as the end handle is dragged", () => {
		renderModal();

		fireEvent.pointerDown(screen.getByRole("button", { name: "Adjust clip end" }), {
			clientX: 0,
		});
		act(() => {
			window.dispatchEvent(new MouseEvent("pointermove", { clientX: -50 }));
		});

		expect(screen.getByTestId("edit-clip-trim-range")).toHaveTextContent("0:20.0–1:40.0");
		expect(screen.getByTestId("edit-clip-final-duration")).toHaveTextContent("1:20.0");
	});
});
