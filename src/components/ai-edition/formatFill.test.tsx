// @vitest-environment jsdom
// The fill row under Format only appears when the format is not the recording's shape, says
// why when it cannot act, and writes the project setting the scene reads.

import "@testing-library/jest-dom";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/contexts/I18nContext";
import type { AxcutDocument } from "@/lib/ai-edition/schema";
import { createEmptyDocument } from "@/lib/ai-edition/schema";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import { VideoEffectsPane } from "./RightPanes";

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }));

function hdTake(editor: Record<string, unknown>): AxcutDocument {
	const base = createEmptyDocument({ title: "T", projectId: "p1" });
	return {
		...base,
		assets: [
			{
				kind: "video",
				id: "a1",
				label: "a1",
				originalPath: "/a1.mp4",
				cameraTrack: null,
				video: { codec: "h264", width: 1920, height: 1080, fps: 30 },
			},
		],
		timeline: {
			...base.timeline,
			clips: [
				{
					id: "c1",
					assetId: "a1",
					sourceStartSec: 0,
					sourceEndSec: 5,
					timelineStartSec: 0,
					timelineEndSec: 5,
					wordRefs: [],
					origin: "user",
					reason: "",
				},
			],
		},
		legacyEditor: editor,
	} as unknown as AxcutDocument;
}

function mount(doc: AxcutDocument) {
	useProjectStore.setState({ document: doc });
	render(
		<I18nProvider>
			<VideoEffectsPane />
		</I18nProvider>,
	);
}

const stored = () =>
	(useProjectStore.getState().document?.legacyEditor as Record<string, unknown> | undefined)
		?.formatFollowCursor;

beforeEach(() => {
	localStorage.clear();
	useProjectStore.setState({ document: null });
});
afterEach(() => {
	cleanup();
	localStorage.clear();
});

describe("format fill", () => {
	it("is not listed when the format is the recording's shape", () => {
		mount(hdTake({ aspectRatio: "16:9" }));
		expect(screen.queryByRole("group", { name: "Recording" })).not.toBeInTheDocument();
	});

	it("switches a 9:16 project between the whole recording and a window on the cursor", async () => {
		mount(hdTake({ aspectRatio: "9:16" }));
		const follow = screen.getByRole("button", { name: "Follow cursor" });
		expect(screen.getByRole("button", { name: "Whole" })).toHaveAttribute("aria-pressed", "true");
		fireEvent.click(follow);
		await waitFor(() => expect(stored()).toBe(true));
		await waitFor(() => expect(follow).toHaveAttribute("aria-pressed", "true"));
	});

	it("fills a format picked from now on, and leaves an earlier project whole", async () => {
		mount(hdTake({ aspectRatio: "16:9" }));
		fireEvent.click(screen.getByRole("button", { name: "Format" }));
		fireEvent.click(await screen.findByRole("menuitem", { name: "9:16" }));
		await waitFor(() => expect(stored()).toBe(true));
		cleanup();

		mount(hdTake({ aspectRatio: "16:9", formatFollowCursor: false }));
		fireEvent.click(screen.getByRole("button", { name: "Format" }));
		fireEvent.click(await screen.findByRole("menuitem", { name: "9:16" }));
		await waitFor(() =>
			expect(
				(useProjectStore.getState().document?.legacyEditor as Record<string, unknown>).aspectRatio,
			).toBe("9:16"),
		);
		expect(stored()).toBe(false);
	});

	it("is not offered under a device frame", () => {
		mount(hdTake({ aspectRatio: "9:16", frame: "laptop", formatFollowCursor: true }));
		expect(screen.queryByRole("button", { name: "Follow cursor" })).toBeNull();
	});
});
