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
import { exportGifNative, exportMultiNative } from "@/native";
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

/** A 640x360 recording: both fixed tiers, 720p and 1080p, are bigger than it. */
const SMALL_SOURCE_DOC: AxcutDocument = {
	...DOC,
	assets: [{ ...DOC.assets[0], video: { codec: "h264", width: 640, height: 360, fps: 60 } }],
};

function renderDialog(document: AxcutDocument = DOC) {
	render(
		<I18nProvider>
			<ExportDialog open={true} onClose={noop} document={document} />
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

/** Same for a GIF, counting calls so a run of exports cannot read the previous one's params. */
async function exportGif() {
	const calls = vi.mocked(exportGifNative).mock.calls.length;
	fireEvent.click(screen.getByRole("button", { name: /export gif/i }));
	await waitFor(() => expect(exportGifNative).toHaveBeenCalledTimes(calls + 1));
	await screen.findByTestId("export-show-in-folder");
	return vi.mocked(exportGifNative).mock.calls[calls][3];
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

describe("ExportDialog format settings", () => {
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

	it("opens on MP4, 1080p, 60 fps, H.264, with no codec choice to make", async () => {
		renderDialog();
		// No picker, on purpose: H.265 is software-only on Linux, slower than software on
		// the measured Macs, and unreadable in half the players. Every export is H.264.
		expect(screen.queryByRole("button", { name: "H.265" })).toBeNull();
		expect(screen.queryByRole("button", { name: "H.264" })).toBeNull();
		// And no idle hint plate: the format is the first control on screen and already picked.
		expect(screen.queryByText(/pick a format/i)).toBeNull();
		expect(await exportMp4()).toMatchObject({ width: 1920, height: 1080, fps: 60, codec: "h264" });
	});

	it("half the frame rate is half the bitrate, same frame", async () => {
		renderDialog();
		const web = await exportMp4();
		fireEvent.click(screen.getByRole("button", { name: "30" }));
		const social = await exportMp4();
		expect(social).toMatchObject({ width: web?.width, height: web?.height, fps: 30 });
		expect(social?.bitrate).toBe((web?.bitrate ?? 0) / 2);
	});

	it("gives the GIF loop toggle an accessible name", () => {
		// The switch renders no text of its own; without a name a screen reader only
		// announces "pressed" and never says which setting it is.
		renderDialog();
		fireEvent.click(screen.getByRole("button", { name: "GIF" }));
		expect(screen.getByRole("button", { name: "Loop GIF" })).toHaveAttribute(
			"aria-pressed",
			"true",
		);
	});

	it("a GIF is 15 fps and README-sized at the small preset", async () => {
		renderDialog();
		fireEvent.click(screen.getByRole("button", { name: "GIF" }));
		fireEvent.click(screen.getByRole("button", { name: "Small (480p)" }));
		expect(await exportGif()).toMatchObject({
			width: 852,
			height: 480,
			fps: 15,
			loopCount: 0,
		});
	});

	it("sizes a GIF from the source, whatever MP4 tier was picked before", async () => {
		// The report on #814: a 640x360 clip got an 852x480 GIF straight away, sized from the
		// 1080p tier the dialog opens on. It must always come off the source size.
		renderDialog(SMALL_SOURCE_DOC);
		fireEvent.click(screen.getByRole("button", { name: "GIF" }));
		fireEvent.click(screen.getByRole("button", { name: "Small (480p)" }));
		const direct = await exportGif();
		expect(direct).toMatchObject({ width: 640, height: 360 });

		fireEvent.click(screen.getByRole("button", { name: "MP4" }));
		fireEvent.click(screen.getByRole("button", { name: /^Source/ }));
		fireEvent.click(screen.getByRole("button", { name: "GIF" }));
		expect(await exportGif()).toEqual(direct);
	});

	it("never exports a GIF bigger than its source, whatever the tier and size preset", async () => {
		renderDialog(SMALL_SOURCE_DOC);
		for (const tier of [/^720p/, /^1080p/, /^Source/]) {
			fireEvent.click(screen.getByRole("button", { name: "MP4" }));
			fireEvent.click(screen.getByRole("button", { name: tier }));
			fireEvent.click(screen.getByRole("button", { name: "GIF" }));
			for (const size of ["Small (480p)", "Medium (720p)", "Large (1080p)", "Original"]) {
				fireEvent.click(screen.getByRole("button", { name: size }));
				expect(await exportGif()).toMatchObject({ width: 640, height: 360 });
			}
		}
	});
});
