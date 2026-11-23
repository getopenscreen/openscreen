// @vitest-environment jsdom
// A still is never transcribed and its card has no regenerate control, so its block must
// not tell the user to regenerate a transcript (#1668). A video without one still does.

import "@testing-library/jest-dom";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/contexts/I18nContext";
import type { AxcutAsset, AxcutClip, AxcutTranscript } from "@/lib/ai-edition/schema";
import { TranscriptPane } from "./RightPanes";

vi.mock("@/native/client", () => ({
	nativeBridgeClient: { aiEdition: {} },
}));

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

const asset = (id: string, originalPath: string): AxcutAsset => ({
	id,
	kind: "video",
	label: id,
	originalPath,
	durationSec: 4,
	cameraTrack: null,
});

const clip = (id: string, assetId: string, start: number): AxcutClip => ({
	id,
	assetId,
	sourceStartSec: 0,
	sourceEndSec: 4,
	timelineStartSec: start,
	timelineEndSec: start + 4,
	wordRefs: [],
	origin: "user",
	reason: "",
});

// The pane only lists blocks once some media has a transcript.
const TRANSCRIPT: AxcutTranscript = {
	assetId: "spoken",
	language: "en",
	segments: [],
	words: [{ id: "w1", segmentId: "s", startSec: 0, endSec: 1, text: "Hello" }],
};

function renderPane(other: AxcutAsset) {
	render(
		<I18nProvider>
			<TranscriptPane
				clips={[clip("clip_1", "spoken", 0), clip("clip_2", other.id, 4)]}
				audioTracks={[]}
				transcripts={[TRANSCRIPT]}
				assets={[asset("spoken", "/rec.mp4"), other]}
				trimRanges={[]}
				busyAssetIds={[]}
				onSeek={vi.fn()}
				onTrimTimelineSpan={vi.fn()}
				onRemoveTrimRanges={vi.fn()}
				onSetWordText={vi.fn()}
				onInsertWord={vi.fn()}
				onRemoveWords={vi.fn()}
				onTranscribe={vi.fn()}
				canTranscribe
				isTranscribing={false}
			/>
		</I18nProvider>,
	);
}

const REGENERATE = /open the asset card and regenerate/;

afterEach(() => {
	cleanup();
});

describe("transcript block of a clip with no transcript", () => {
	it("gives no regenerate advice for a still", () => {
		renderPane(asset("still", "/photo.still.mp4"));
		expect(screen.queryByText(REGENERATE)).toBeNull();
	});

	it("keeps the advice for a video", () => {
		renderPane(asset("silent", "/other.mp4"));
		expect(screen.getByText(REGENERATE)).toBeInTheDocument();
	});
});
