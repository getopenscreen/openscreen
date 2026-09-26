// @vitest-environment jsdom
// What the export dialog hands the native exporter. The MP4 bitrate used to be computed here and
// never sent, so every export ran at the pipeline's own 8 Mb/s at 1080p, whatever its frame rate.
import "@testing-library/jest-dom";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("sonner", () => ({
	toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("@/native", () => ({
	exportMultiNative: vi.fn(async () => ({ videoDurationS: 10, wallS: 2 })),
	exportGifNative: vi.fn(async () => ({ videoDurationS: 10, wallS: 2 })),
	useIsCpuCompositor: () => false,
}));

vi.mock("@/native/sceneDescription", () => ({
	buildSceneDescription: () => ({ speedRegions: [] }),
	resolveVisibleClips: (doc: AxcutDocument) => doc.timeline.clips,
}));

import { I18nProvider } from "@/contexts/I18nContext";
import { type AxcutDocument, axcutSchemaVersion } from "@/lib/ai-edition/schema";
import { calculateMp4ExportSettings } from "@/lib/exporter/mp4ExportSettings";
import { exportMultiNative } from "@/native";
import { ExportDialog } from "./ExportDialog";

type ElectronAPI = Window["electronAPI"];

const noop = () => undefined;

const DOC: AxcutDocument = {
	schemaVersion: axcutSchemaVersion,
	project: {
		id: "proj_1",
		title: "Params",
		createdAt: "2026-09-25T10:00:00Z",
		updatedAt: "2026-09-25T10:00:00Z",
		primaryAssetId: "a1",
	},
	assets: [
		{
			id: "a1",
			kind: "video",
			label: "asset",
			originalPath: "/tmp/a.mp4",
			cameraTrack: null,
			video: { codec: "h264", width: 1920, height: 1080, fps: 60 },
		},
	],
	transcript: null,
	transcripts: [],
	timeline: {
		clips: [
			{
				id: "c1",
				assetId: "a1",
				sourceStartSec: 0,
				sourceEndSec: 10,
				timelineStartSec: 0,
				timelineEndSec: 10,
				wordRefs: [],
				origin: "user",
				reason: "",
			},
		],
		gaps: [],
		trimRanges: [],
		muteRanges: [],
		speedRanges: [],
		captionRanges: [],
	},
	annotations: [],
	zoomRanges: [],
	audioTracks: [],
	// A fixed format, so the 1080p tier is exactly 1920x1080 (Auto adds its padding border).
	legacyEditor: { aspectRatio: "16:9" },
};

function renderDialog() {
	render(
		<I18nProvider>
			<ExportDialog open={true} onClose={noop} document={DOC} />
		</I18nProvider>,
	);
}

/** Clicks Export, waits for the native call, and hands back the params it received. */
async function exportMp4() {
	fireEvent.click(screen.getByRole("button", { name: /export mp4/i }));
	await waitFor(() => expect(exportMultiNative).toHaveBeenCalled());
	const params = vi.mocked(exportMultiNative).mock.calls.at(-1)?.[3];
	await screen.findByTestId("export-show-in-folder");
	return params;
}

describe("ExportDialog MP4 params", () => {
	beforeEach(() => {
		window.electronAPI = {
			pickExportSavePath: vi.fn(async () => ({ path: "/tmp/out.mp4" })),
			onNativeExportProgress: vi.fn(() => noop),
		} as unknown as ElectronAPI;
	});

	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
	});

	it("sends the bitrate for the frame rate it exports at", async () => {
		renderDialog();
		const expected = (frameRate: number) =>
			calculateMp4ExportSettings({
				quality: "good",
				sourceWidth: 1920,
				sourceHeight: 1080,
				aspectRatioValue: 16 / 9,
				frameRate,
			}).bitrate;

		const at60 = await exportMp4();
		expect(at60).toMatchObject({ width: 1920, height: 1080, fps: 60, bitrate: expected(60) });

		fireEvent.click(screen.getByRole("button", { name: "30" }));
		const at30 = await exportMp4();
		expect(at30).toMatchObject({ fps: 30, bitrate: expected(30) });
		expect(at30?.bitrate).toBeLessThan(at60?.bitrate ?? 0);
	});
});
