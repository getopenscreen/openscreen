// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/native", () => ({
	exportMultiNative: vi.fn(),
	exportGifNative: vi.fn(),
	cancelGifExportNative: vi.fn(async () => ({ accepted: true })),
	useIsCpuCompositor: () => false,
}));
vi.mock("@/native/sceneDescription", () => ({
	buildSceneDescription: () => ({ speedRegions: [] }),
	resolveVisibleClips: (doc: AxcutDocument) => doc.timeline.clips,
}));

import { toast } from "sonner";
import { I18nProvider } from "@/contexts/I18nContext";
import { type AxcutDocument, axcutSchemaVersion } from "@/lib/ai-edition/schema";
import { cancelGifExportNative, exportGifNative } from "@/native";
import { NativeBridgeRequestError } from "@/native/client";
import type { CompositorExportGifResult } from "@/native/contracts";
import { ExportDialog } from "./ExportDialog";

const DOC: AxcutDocument = {
	schemaVersion: axcutSchemaVersion,
	project: {
		id: "proj_1",
		title: "Cancellation test",
		createdAt: "2026-06-26T10:00:00Z",
		updatedAt: "2026-06-26T10:00:00Z",
		primaryAssetId: "a1",
	},
	assets: [
		{
			id: "a1",
			kind: "video",
			label: "asset",
			originalPath: "/tmp/a.mp4",
			cameraTrack: null,
			video: { codec: "h264", width: 1920, height: 1080, fps: 30 },
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
	legacyEditor: null,
};
const STATS: CompositorExportGifResult = {
	frames: 150,
	wallS: 1,
	fps: 150,
	videoDurationS: 10,
	fileBytes: 4000,
};

function pendingExport() {
	let resolve!: (stats: CompositorExportGifResult) => void;
	let reject!: (error: Error) => void;
	const result = new Promise<CompositorExportGifResult>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	vi.mocked(exportGifNative).mockReturnValueOnce(result);
	return { resolve, reject };
}

let progress: (frames: number, exportId?: string) => void;
let unsubscribe: ReturnType<typeof vi.fn>;
let onClose: ReturnType<typeof vi.fn<() => void>>;

async function start() {
	const view = render(
		<I18nProvider>
			<ExportDialog open onClose={onClose} document={DOC} />
		</I18nProvider>,
	);
	fireEvent.click(screen.getByRole("button", { name: "GIF" }));
	fireEvent.click(screen.getByRole("button", { name: "Export GIF" }));
	await waitFor(() => expect(exportGifNative).toHaveBeenCalledOnce());
	const id = vi.mocked(exportGifNative).mock.calls[0][4];
	expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
	return { ...view, id };
}

describe("GIF export cancellation", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(cancelGifExportNative).mockResolvedValue({ accepted: true });
		onClose = vi.fn();
		unsubscribe = vi.fn();
		window.electronAPI = {
			pickExportSavePath: vi.fn(async () => ({ path: "/tmp/result.gif" })),
			onNativeExportProgress: vi.fn((cb) => {
				progress = cb;
				return unsubscribe;
			}),
		} as unknown as Window["electronAPI"];
	});
	afterEach(cleanup);

	it("enables Cancel immediately, waits for cleanup and returns to the same options", async () => {
		const job = pendingExport();
		const { id } = await start();
		const cancel = screen.getByRole("button", { name: "Cancel" });
		expect(cancel).toBeEnabled();
		fireEvent.click(cancel);
		await waitFor(() => expect(cancelGifExportNative).toHaveBeenCalledWith(id));
		expect(cancel).toBeDisabled();
		fireEvent.click(cancel);
		expect(cancelGifExportNative).toHaveBeenCalledOnce();
		expect(screen.queryByRole("button", { name: "Export GIF" })).not.toBeInTheDocument();
		await act(async () =>
			job.reject(
				new NativeBridgeRequestError({
					code: "CANCELLED",
					message: "cancelled",
					retryable: false,
				}),
			),
		);
		expect(screen.getByRole("button", { name: "Export GIF" })).toBeEnabled();
		expect(screen.getByRole("dialog")).toBeVisible();
		expect(onClose).not.toHaveBeenCalled();
		expect(toast.success).not.toHaveBeenCalled();
		expect(toast.error).not.toHaveBeenCalled();
		expect(unsubscribe).toHaveBeenCalledOnce();
	});

	it("retries with a new ID, ignores old progress and then exports successfully", async () => {
		const first = pendingExport();
		const { id } = await start();
		const staleProgress = progress;
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		await act(async () =>
			first.reject(
				new NativeBridgeRequestError({
					code: "CANCELLED",
					message: "cancelled",
					retryable: false,
				}),
			),
		);
		const second = pendingExport();
		fireEvent.click(screen.getByRole("button", { name: "Export GIF" }));
		await waitFor(() => expect(exportGifNative).toHaveBeenCalledTimes(2));
		const nextId = vi.mocked(exportGifNative).mock.calls[1][4];
		expect(nextId).not.toBe(id);
		expect(vi.mocked(exportGifNative).mock.calls[1][3]).toEqual(
			vi.mocked(exportGifNative).mock.calls[0][3],
		);
		const before = screen.getByRole("dialog").textContent;
		act(() => {
			staleProgress(149, id);
			progress(149, id);
		});
		expect(screen.getByRole("dialog").textContent).toBe(before);
		act(() => progress(75, nextId));
		expect(screen.getByRole("dialog").textContent).not.toBe(before);
		await act(async () => second.resolve(STATS));
		expect(screen.getByText("/tmp/result.gif")).toBeVisible();
		expect(toast.success).toHaveBeenCalledOnce();
	});

	it("surfaces a rejected cancel request instead of keeping the progress view", async () => {
		vi.mocked(cancelGifExportNative).mockRejectedValueOnce(new Error("cancel ipc failed"));
		pendingExport();
		await start();
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		await waitFor(() => expect(screen.getByText("cancel ipc failed")).toBeVisible());
		expect(toast.error).toHaveBeenCalledWith("cancel ipc failed");
		expect(toast.success).not.toHaveBeenCalled();
		expect(screen.queryByText(/Rendering frames/i)).not.toBeInTheDocument();
	});

	it("reports success when native publication wins the race", async () => {
		vi.mocked(cancelGifExportNative).mockResolvedValue({ accepted: false });
		const job = pendingExport();
		await start();
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		await act(async () => job.resolve(STATS));
		expect(screen.getByText("/tmp/result.gif")).toBeVisible();
		expect(toast.success).toHaveBeenCalledOnce();
		expect(toast.error).not.toHaveBeenCalled();
	});

	it("does not hide a real export error after a cancellation request", async () => {
		const job = pendingExport();
		await start();
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		await act(async () => job.reject(new Error("disk full")));
		expect(screen.getByText("disk full")).toBeVisible();
		expect(toast.error).toHaveBeenCalledOnce();
		expect(toast.success).not.toHaveBeenCalled();
	});

	it("requests cancellation on unmount and ignores later settlement", async () => {
		const job = pendingExport();
		const { id, unmount } = await start();
		unmount();
		expect(cancelGifExportNative).toHaveBeenCalledWith(id);
		await act(async () => job.resolve(STATS));
		expect(toast.success).not.toHaveBeenCalled();
		expect(toast.error).not.toHaveBeenCalled();
	});

	it("does not start an export when the save picker returns after unmount", async () => {
		let choose!: (value: { success: boolean; path: string }) => void;
		window.electronAPI.pickExportSavePath = vi.fn(
			() =>
				new Promise<{ success: boolean; path: string }>((resolve) => {
					choose = resolve;
				}),
		);
		const view = render(
			<I18nProvider>
				<ExportDialog open onClose={onClose} document={DOC} />
			</I18nProvider>,
		);
		fireEvent.click(screen.getByRole("button", { name: "GIF" }));
		fireEvent.click(screen.getByRole("button", { name: "Export GIF" }));
		view.unmount();
		await act(async () => choose({ success: true, path: "/tmp/late.gif" }));
		expect(exportGifNative).not.toHaveBeenCalled();
	});
});
