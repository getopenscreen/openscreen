// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const actions = vi.hoisted(() => ({
	importSrt: vi.fn(async (_assetId: string, _text: string) => undefined),
	request: vi.fn(),
}));

vi.mock("@/lib/ai-edition/store/transcriptionStore", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/ai-edition/store/transcriptionStore")>();
	return {
		...actual,
		useAssetTranscriptions: () => ({}),
		useTranscriptionStore: Object.assign(
			(select: (state: { request: unknown }) => unknown) => select({ request: actions.request }),
			{ getState: () => ({ importSrt: actions.importSrt }) },
		),
	};
});

vi.mock("@/contexts/I18nContext", () => ({
	useI18n: () => ({ locale: "en", setLocale: vi.fn() }),
	useScopedT: () => (key: string) => key,
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import { toast } from "sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { parseSrtTranscript } from "@/lib/ai-edition/document/srtImport";
import {
	assetSchema,
	clipSchema,
	createEmptyDocument,
	transcriptSchema,
} from "@/lib/ai-edition/schema";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import { MediaStage } from "./MediaStage";

const SRT = "\uFEFF1\r\n00:00:00,250 --> 00:00:02,750\r\n繁體字幕\r\n";
const ORIGINAL_PATH = "/recordings/原始影片.mp4";
const reveal = vi.fn(async (_path: string) => ({ success: true }));
type FileResult = { success: boolean; canceled?: boolean; path?: string; error?: string };
const exportAudio = vi.fn(
	async (_options: { sourcePath: string; format: string }): Promise<FileResult> => ({
		success: true,
		path: "/recordings/source.m4a",
	}),
);
const exportSrt = vi.fn(
	async (_options: { sourcePath: string; srtText: string }): Promise<FileResult> => ({
		success: true,
		path: "/recordings/source.srt",
	}),
);
const audioPicker = vi.fn(
	async (): Promise<FileResult & { name?: string }> => ({ success: false, canceled: true }),
);
const originalImportAudioAsset = useProjectStore.getState().importAudioAsset;
const originalAddAudioAsset = useProjectStore.getState().addAudioAsset;

class StubResizeObserver {
	observe = vi.fn();
	unobserve = vi.fn();
	disconnect = vi.fn();
}

function withExistingTranscript() {
	const document = useProjectStore.getState().document;
	if (!document) throw new Error("Missing test document");
	useProjectStore.setState({
		document: {
			...document,
			transcripts: [
				transcriptSchema.parse({
					assetId: "asset-1",
					language: "zh",
					segments: [
						{
							id: "existing",
							kind: "speech",
							startSec: 0,
							endSec: 1,
							text: "Existing subtitles",
							wordIds: [],
						},
					],
				}),
			],
		},
	});
}

beforeEach(() => {
	vi.stubGlobal("ResizeObserver", StubResizeObserver);
	vi.stubGlobal("electronAPI", {
		revealInFolder: reveal,
		exportSourceAudio: exportAudio,
		exportSrtFile: exportSrt,
		openAudioFilePicker: audioPicker,
		cancelSourceAudioExport: vi.fn(),
	});
	vi.spyOn(window, "confirm").mockReturnValue(true);
	actions.importSrt.mockReset();
	actions.importSrt.mockResolvedValue(undefined);
	actions.request.mockReset();
	reveal.mockReset();
	reveal.mockResolvedValue({ success: true });
	exportAudio.mockReset().mockResolvedValue({ success: true, path: "/recordings/source.m4a" });
	exportSrt.mockReset().mockResolvedValue({ success: true, path: "/recordings/source.srt" });
	audioPicker.mockReset().mockResolvedValue({ success: false, canceled: true });
	vi.mocked(toast.success).mockClear();
	vi.mocked(toast.error).mockClear();
	vi.mocked(toast.info).mockClear();
	const document = createEmptyDocument({ projectId: "p", title: "Test" });
	useProjectStore.setState({
		projectId: "p",
		document: {
			...document,
			assets: [
				assetSchema.parse({ id: "asset-1", label: "Take one", originalPath: ORIGINAL_PATH }),
				assetSchema.parse({ id: "asset-2", label: "Take two", originalPath: "/rec/two.mp4" }),
			],
		},
	});
});

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	useProjectStore.setState({
		document: null,
		projectId: null,
		importAudioAsset: originalImportAudioAsset,
		addAudioAsset: originalAddAudioAsset,
	});
});

async function openDetail() {
	const view = render(
		<TooltipProvider>
			<MediaStage onAddToTimeline={vi.fn(async () => undefined)} />
		</TooltipProvider>,
	);
	fireEvent.click(await screen.findByRole("button", { name: /Take one/ }));
	return {
		...view,
		input: screen.getByLabelText("mediaStage.srtFileLabel") as HTMLInputElement,
		importButton: screen.getByRole("button", { name: "mediaStage.importSrt" }),
	};
}

function chooseFile(input: HTMLInputElement, text = Promise.resolve(SRT), name = "captions.srt") {
	const file = new File([SRT], name, { type: "application/x-subrip" });
	const read = vi.fn(() => text);
	Object.defineProperty(file, "text", { value: read });
	fireEvent.change(input, { target: { files: [file] } });
	return { file, read };
}

describe("MediaStage original video and SRT actions", () => {
	it.each([
		"original",
		"wav",
		"m4a",
	])("exports the selected source using %s without starting transcription", async (format) => {
		await openDetail();
		fireEvent.change(screen.getByLabelText("mediaStage.audioFormat"), {
			target: { value: format },
		});
		fireEvent.click(screen.getByRole("button", { name: "mediaStage.exportAudio" }));
		await waitFor(() =>
			expect(exportAudio).toHaveBeenCalledWith({ sourcePath: ORIGINAL_PATH, format }),
		);
		expect(actions.request).not.toHaveBeenCalled();
		expect(toast.success).toHaveBeenCalledWith(
			"mediaStage.audioExported",
			expect.objectContaining({ description: "/recordings/source.m4a" }),
		);
	});

	it("does not claim success when the save dialog is cancelled", async () => {
		exportAudio.mockResolvedValueOnce({ success: false, canceled: true });
		await openDetail();
		fireEvent.click(screen.getByRole("button", { name: "mediaStage.exportAudio" }));
		await waitFor(() =>
			expect(screen.getByRole("button", { name: "mediaStage.exportAudio" })).toBeEnabled(),
		);
		expect(toast.success).not.toHaveBeenCalled();
		expect(toast.error).not.toHaveBeenCalled();
	});

	it("keeps exports disabled during a pending write and surfaces a backend error", async () => {
		let finish!: (result: FileResult) => void;
		exportAudio.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		await openDetail();
		fireEvent.click(screen.getByRole("button", { name: "mediaStage.exportAudio" }));
		expect(screen.getByRole("button", { name: "mediaStage.exporting" })).toBeDisabled();
		expect(screen.getByLabelText("mediaStage.audioFormat")).toBeDisabled();
		await act(async () => finish({ success: false, error: "No audio stream" }));
		expect(toast.error).toHaveBeenCalledWith("mediaStage.exportFailed", {
			description: "No audio stream",
		});
	});

	it("disables SRT export until captions exist and exports the original cue times", async () => {
		await openDetail();
		expect(screen.getByRole("button", { name: "mediaStage.exportSrt" })).toBeDisabled();
		act(() => withExistingTranscript());
		fireEvent.click(screen.getByRole("button", { name: "mediaStage.exportSrt" }));
		await waitFor(() =>
			expect(exportSrt).toHaveBeenCalledWith({
				sourcePath: ORIGINAL_PATH,
				srtText: "1\n00:00:00,000 --> 00:00:01,000\nExisting subtitles\n",
				scope: "source",
			}),
		);
		expect(actions.request).not.toHaveBeenCalled();
	});

	it("exports the selected timeline scope using the edited output clock", async () => {
		const doc = useProjectStore.getState().document!;
		const caption = parseSrtTranscript("asset-1", "1\n00:00:06,000 --> 00:00:08,000\n繁體字幕\n");
		useProjectStore.setState({
			document: {
				...doc,
				transcripts: [caption],
				timeline: {
					...doc.timeline,
					clips: [
						clipSchema.parse({
							id: "clip",
							assetId: "asset-1",
							sourceStartSec: 0,
							sourceEndSec: 10,
							timelineStartSec: 0,
							timelineEndSec: 10,
							origin: "user",
						}),
					],
					trimRanges: [
						{
							id: "cut",
							assetId: "asset-1",
							clipId: "clip",
							startSec: 2,
							endSec: 4,
							origin: "user",
							reason: "cut",
						},
					],
				},
				legacyEditor: { speedRegions: [{ id: "speed", startMs: 4000, endMs: 8000, speed: 2 }] },
			},
		});
		await openDetail();
		fireEvent.change(screen.getByLabelText("mediaStage.srtScope"), {
			target: { value: "timeline" },
		});
		fireEvent.click(screen.getByRole("button", { name: "mediaStage.exportSrt" }));
		await waitFor(() =>
			expect(exportSrt).toHaveBeenCalledWith({
				sourcePath: ORIGINAL_PATH,
				scope: "timeline",
				srtText: "1\n00:00:03,000 --> 00:00:04,000\n繁體字幕\n",
			}),
		);
	});

	it("opens the dedicated transcription settings dialog", async () => {
		await openDetail();
		fireEvent.click(screen.getByRole("button", { name: "mediaStage.transcriptionMethods" }));
		expect(
			screen.getByRole("dialog", { name: "mediaStage.transcriptionMethods" }),
		).toBeInTheDocument();
	});

	it("imports audio through the existing overlay path when video is on the timeline", async () => {
		const doc = useProjectStore.getState().document!;
		const audio = assetSchema.parse({
			id: "audio-1",
			kind: "audio",
			label: "Speech.wav",
			originalPath: "/recordings/Speech.wav",
		});
		const importAudio = vi.fn(async () => audio);
		const addAudio = vi.fn(async () => audio);
		const onImported = vi.fn();
		const onShowTimeline = vi.fn();
		useProjectStore.setState({
			importAudioAsset: importAudio,
			addAudioAsset: addAudio,
			document: {
				...doc,
				timeline: {
					...doc.timeline,
					clips: [
						clipSchema.parse({
							id: "clip",
							assetId: "asset-1",
							sourceStartSec: 0,
							sourceEndSec: 10,
							timelineStartSec: 0,
							timelineEndSec: 10,
							origin: "user",
						}),
					],
				},
			},
		});
		audioPicker.mockResolvedValueOnce({
			success: true,
			path: audio.originalPath,
			name: audio.label,
		});
		render(
			<TooltipProvider>
				<MediaStage
					onAddToTimeline={vi.fn()}
					onAudioTrackImported={onImported}
					onShowTimeline={onShowTimeline}
				/>
			</TooltipProvider>,
		);
		fireEvent.click(screen.getByRole("button", { name: "mediaStage.importAudio" }));
		await waitFor(() => expect(importAudio).toHaveBeenCalledWith(audio.originalPath, audio.label));
		expect(addAudio).not.toHaveBeenCalled();
		expect(onImported).toHaveBeenCalledOnce();
		expect(toast.success).toHaveBeenCalledWith(
			"mediaStage.audioImportedToTimeline",
			expect.objectContaining({
				action: { label: "mediaStage.showTimeline", onClick: onShowTimeline },
			}),
		);
	});

	it("imports an audio-only source without sending it through the video clip route", async () => {
		const audio = assetSchema.parse({
			id: "audio-1",
			kind: "audio",
			label: "Speech.wav",
			originalPath: "/recordings/Speech.wav",
		});
		const addAudio = vi.fn(async () => {
			const doc = useProjectStore.getState().document!;
			useProjectStore.setState({ document: { ...doc, assets: [...doc.assets, audio] } });
			return audio;
		});
		const importAudio = vi.fn(async () => audio);
		useProjectStore.setState({ addAudioAsset: addAudio, importAudioAsset: importAudio });
		audioPicker.mockResolvedValueOnce({
			success: true,
			path: audio.originalPath,
			name: audio.label,
		});
		await openDetail();
		fireEvent.click(screen.getByRole("button", { name: "mediaStage.importAudio" }));
		await waitFor(() => expect(addAudio).toHaveBeenCalledWith(audio.originalPath, audio.label));
		expect(importAudio).not.toHaveBeenCalled();
		const card = screen.getByRole("button", { name: /Speech.wav/ });
		expect(card).toHaveAttribute("draggable", "false");
		expect(screen.getByRole("button", { name: "mediaStage.addToTimeline" })).toBeDisabled();
		expect(screen.getByText("mediaStage.audioNeedsVideo")).toBeInTheDocument();
	});

	it("discards an audio picker result after the project changes", async () => {
		let finish!: (result: FileResult) => void;
		audioPicker.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		const addAudio = vi.fn(async () => null);
		useProjectStore.setState({ addAudioAsset: addAudio });
		await openDetail();
		fireEvent.click(screen.getByRole("button", { name: "mediaStage.importAudio" }));
		act(() => useProjectStore.setState({ projectId: "other" }));
		await act(async () => finish({ success: true, path: "/recordings/speech.wav" }));
		expect(addAudio).not.toHaveBeenCalled();
		expect(toast.success).not.toHaveBeenCalled();
	});

	it("reveals the selected original file through the existing bridge", async () => {
		await openDetail();
		fireEvent.click(screen.getByRole("button", { name: "mediaStage.revealOriginal" }));
		await waitFor(() => expect(reveal).toHaveBeenCalledWith(ORIGINAL_PATH));
		expect(actions.request).not.toHaveBeenCalled();
	});

	it("reports a failed reveal", async () => {
		reveal.mockRejectedValueOnce(new Error("File was moved"));
		await openDetail();
		fireEvent.click(screen.getByRole("button", { name: "mediaStage.revealOriginal" }));
		await waitFor(() =>
			expect(toast.error).toHaveBeenCalledWith("mediaStage.revealFailed", {
				description: "File was moved",
			}),
		);
	});

	it("imports the chosen local SRT into the selected asset without calling a transcription service", async () => {
		const { input, importButton } = await openDetail();
		expect(input).toHaveAttribute("accept", ".srt");
		fireEvent.click(importButton);
		chooseFile(input);
		await waitFor(() => expect(actions.importSrt).toHaveBeenCalledWith("asset-1", SRT));
		expect(actions.request).not.toHaveBeenCalled();
		expect(window.confirm).not.toHaveBeenCalled();
		expect(toast.success).toHaveBeenCalledWith("mediaStage.importSrtSuccess");
	});

	it("cancelling the file picker makes no changes and allows another pick", async () => {
		const { input, importButton } = await openDetail();
		fireEvent.click(importButton);
		fireEvent(input, new Event("cancel"));
		expect(actions.importSrt).not.toHaveBeenCalled();
		expect(screen.getByRole("button", { name: "mediaStage.importSrt" })).toBeEnabled();
		fireEvent.click(screen.getByRole("button", { name: "mediaStage.importSrt" }));
		chooseFile(input);
		await waitFor(() => expect(actions.importSrt).toHaveBeenCalledTimes(1));
	});

	it("does not open a picker when replacement is declined", async () => {
		withExistingTranscript();
		vi.mocked(window.confirm).mockReturnValue(false);
		const { input, importButton } = await openDetail();
		const click = vi.spyOn(input, "click");
		fireEvent.click(importButton);
		expect(window.confirm).toHaveBeenCalledWith("mediaStage.srtReplaceConfirm");
		expect(click).not.toHaveBeenCalled();
		expect(actions.importSrt).not.toHaveBeenCalled();
		expect(importButton).toBeEnabled();
	});

	it("imports over existing subtitles only after confirming replacement", async () => {
		withExistingTranscript();
		const { input, importButton } = await openDetail();
		fireEvent.click(importButton);
		chooseFile(input);
		await waitFor(() => expect(actions.importSrt).toHaveBeenCalledTimes(1));
		expect(window.confirm).toHaveBeenCalledTimes(1);
	});

	it("rejects a file-dialog result after selecting another asset", async () => {
		const { input, importButton } = await openDetail();
		fireEvent.click(importButton);
		fireEvent.click(screen.getByRole("button", { name: /Take two/ }));
		chooseFile(input);
		await waitFor(() => expect(toast.info).toHaveBeenCalledWith("mediaStage.srtSelectionChanged"));
		expect(actions.importSrt).not.toHaveBeenCalled();
	});

	it("rejects a pending read after switching projects", async () => {
		let finishRead!: (text: string) => void;
		const pendingRead = new Promise<string>((resolve) => {
			finishRead = resolve;
		});
		const { input, importButton } = await openDetail();
		fireEvent.click(importButton);
		chooseFile(input, pendingRead);
		act(() => {
			useProjectStore.setState({
				projectId: "other",
				document: createEmptyDocument({ projectId: "other", title: "Other" }),
			});
		});
		await act(async () => finishRead(SRT));
		expect(actions.importSrt).not.toHaveBeenCalled();
		expect(toast.info).toHaveBeenCalledWith("mediaStage.srtSelectionChanged");
	});

	it("does not write a pending file after the pane unmounts", async () => {
		let finishRead!: (text: string) => void;
		const pendingRead = new Promise<string>((resolve) => {
			finishRead = resolve;
		});
		const { input, importButton, unmount } = await openDetail();
		fireEvent.click(importButton);
		chooseFile(input, pendingRead);
		unmount();
		await act(async () => finishRead(SRT));
		expect(actions.importSrt).not.toHaveBeenCalled();
		expect(toast.success).not.toHaveBeenCalled();
	});

	it("asks again if a background transcription completed while the picker was open", async () => {
		const { input, importButton } = await openDetail();
		fireEvent.click(importButton);
		act(() => withExistingTranscript());
		vi.mocked(window.confirm).mockReturnValue(false);
		chooseFile(input);
		await waitFor(() => expect(window.confirm).toHaveBeenCalledTimes(1));
		expect(actions.importSrt).not.toHaveBeenCalled();
	});

	it("rejects files above the size limit before reading them", async () => {
		const { input, importButton } = await openDetail();
		fireEvent.click(importButton);
		const file = new File(["x"], "large.srt");
		Object.defineProperty(file, "size", { value: 5 * 1024 * 1024 + 1 });
		const read = vi.fn();
		Object.defineProperty(file, "text", { value: read });
		fireEvent.change(input, { target: { files: [file] } });
		await waitFor(() =>
			expect(toast.error).toHaveBeenCalledWith("mediaStage.importSrtFailed", {
				description: "mediaStage.srtTooLarge",
			}),
		);
		expect(read).not.toHaveBeenCalled();
		expect(actions.importSrt).not.toHaveBeenCalled();
	});

	it("blocks duplicate picks and regeneration while a file is being read", async () => {
		let finishRead!: (text: string) => void;
		const pendingRead = new Promise<string>((resolve) => {
			finishRead = resolve;
		});
		const { input, importButton } = await openDetail();
		const click = vi.spyOn(input, "click");
		fireEvent.click(importButton);
		fireEvent.click(importButton);
		expect(click).toHaveBeenCalledTimes(1);
		chooseFile(input, pendingRead);
		fireEvent.click(screen.getByRole("button", { name: "mediaStage.regenerate" }));
		expect(actions.request).not.toHaveBeenCalled();
		await act(async () => finishRead(SRT));
		expect(actions.importSrt).toHaveBeenCalledTimes(1);
	});

	it("reports an invalid SRT and permits trying another file", async () => {
		actions.importSrt.mockRejectedValueOnce(new Error("Invalid SRT timestamp"));
		const { input, importButton } = await openDetail();
		fireEvent.click(importButton);
		chooseFile(input);
		await waitFor(() =>
			expect(toast.error).toHaveBeenCalledWith("mediaStage.importSrtFailed", {
				description: "Invalid SRT timestamp",
			}),
		);
		expect(screen.getByRole("button", { name: "mediaStage.importSrt" })).toBeEnabled();
		expect(toast.success).not.toHaveBeenCalled();
	});
});
