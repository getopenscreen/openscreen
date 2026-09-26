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

		fireEvent.click(screen.getByRole("button", { name: "Advanced" }));
		fireEvent.click(screen.getByRole("button", { name: "30" }));
		const at30 = await exportMp4();
		expect(at30).toMatchObject({ fps: 30, bitrate: expected(30) });
		expect(at30?.bitrate).toBeLessThan(at60?.bitrate ?? 0);
	});
});

describe("ExportDialog destinations", () => {
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

	const destination = (name: RegExp) => screen.getByRole("button", { name });

	it("opens on Web / YouTube, with the detailed settings folded under Advanced", () => {
		renderDialog();
		expect(destination(/Web \/ YouTube/)).toHaveAttribute("aria-pressed", "true");
		expect(destination(/Web \/ YouTube/)).toHaveTextContent("MP4 · 1920 × 1080 · 60 fps");
		expect(screen.getByRole("button", { name: "Advanced" })).toHaveAttribute(
			"aria-expanded",
			"false",
		);
		expect(screen.queryByRole("button", { name: "H.265" })).toBeNull();
	});

	it("Social exports the same frame at half the frame rate, so half the bitrate", async () => {
		renderDialog();
		const web = await exportMp4();
		fireEvent.click(destination(/Social/));
		const social = await exportMp4();
		// Same size: a destination never touches the project's format.
		expect(social).toMatchObject({ width: web?.width, height: web?.height, fps: 30 });
		expect(social?.bitrate).toBe((web?.bitrate ?? 0) / 2);
	});

	it("stops showing a destination as picked once an Advanced setting leaves it", () => {
		renderDialog();
		fireEvent.click(destination(/Social/));
		expect(destination(/Social/)).toHaveAttribute("aria-pressed", "true");
		fireEvent.click(screen.getByRole("button", { name: "Advanced" }));
		fireEvent.click(screen.getByRole("button", { name: "H.265" }));
		for (const d of [/Web \/ YouTube/, /Social/, /Studio/, /README GIF/]) {
			expect(destination(d)).toHaveAttribute("aria-pressed", "false");
		}
	});

	it("README GIF asks for a README-sized GIF", async () => {
		renderDialog();
		fireEvent.click(destination(/README GIF/));
		expect(destination(/README GIF/)).toHaveTextContent("GIF · 852 × 480 · 15 fps");
		fireEvent.click(screen.getByRole("button", { name: /export gif/i }));
		await waitFor(() => expect(exportGifNative).toHaveBeenCalled());
		expect(vi.mocked(exportGifNative).mock.calls[0][3]).toMatchObject({
			width: 852,
			height: 480,
			fps: 15,
			loopCount: 0,
		});
	});
});
