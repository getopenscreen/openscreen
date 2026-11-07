// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { EditorDialogsProvider } from "@/contexts/EditorDialogsContext";
import type { AxcutAsset, AxcutClip, AxcutDocument } from "@/lib/ai-edition/schema";
import { createEmptyDocument } from "@/lib/ai-edition/schema";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import { buildSceneDescription } from "@/native/sceneDescription";

const mocks = vi.hoisted(() => ({
	nativePlaybackSync: vi.fn(),
	previewPlay: vi.fn(async (): Promise<void> => undefined),
	previewPause: vi.fn(),
}));

vi.mock("@/contexts/ShortcutsContext", async () => {
	const { DEFAULT_SHORTCUTS } = await import("@/lib/shortcuts");
	return {
		useShortcuts: () => ({
			shortcuts: DEFAULT_SHORTCUTS,
			isMac: false,
			isConfigOpen: false,
			openConfig: vi.fn(),
			closeConfig: vi.fn(),
			setShortcuts: vi.fn(),
			persistShortcuts: () => Promise.resolve(true),
		}),
	};
});

vi.mock("@/contexts/I18nContext", () => ({
	useI18n: () => ({ locale: "en", setLocale: vi.fn() }),
	useScopedT: () => (key: string) => key,
}));

vi.mock("@/native/useNativePlaybackSync", () => ({
	useNativePlaybackSync: mocks.nativePlaybackSync,
}));

vi.mock("./Preview", async () => {
	const { createElement, useEffect } = await import("react");
	return {
		Preview: ({
			playUneditedTimeline,
			onVideoElement,
		}: {
			playUneditedTimeline?: boolean;
			onVideoElement: (element: HTMLVideoElement | null) => void;
		}) => {
			useEffect(() => {
				const element = document.createElement("video");
				Object.defineProperty(element, "paused", { configurable: true, value: true });
				element.play = mocks.previewPlay;
				element.pause = mocks.previewPause;
				onVideoElement(element);
				return () => onVideoElement(null);
			}, [onVideoElement]);
			return createElement("div", {
				"data-testid": "preview-recording-mode",
				"data-unedited": String(playUneditedTimeline ?? false),
			});
		},
	};
});

vi.mock("./v4/V4Timeline", () => ({
	V4Timeline: ({
		onAddVoiceover,
		setCurrentTime,
		onTogglePlay,
	}: {
		onAddVoiceover: () => void;
		setCurrentTime: (time: number) => void;
		onTogglePlay: () => void;
	}) =>
		createElement(
			"div",
			null,
			createElement("button", { type: "button", onClick: onAddVoiceover }, "open-voiceover"),
			createElement("button", { type: "button", onClick: () => setCurrentTime(9) }, "seek-preview"),
			createElement("button", { type: "button", onClick: onTogglePlay }, "toggle-preview"),
		),
}));

vi.mock("./v4/AddAudioLayerDialog", () => ({
	AddAudioLayerDialog: ({
		open,
		onClose,
		onComplete,
		onRecordingStart,
		onRecordingStop,
		onRecordingPause,
		onRecordingResume,
	}: {
		open: boolean;
		onClose: () => void;
		onComplete: (assetId: string, durationSec: number) => void;
		onRecordingStart: () => void | Promise<void>;
		onRecordingStop: () => void;
		onRecordingPause: () => void;
		onRecordingResume: () => void | Promise<void>;
	}) =>
		open
			? createElement(
					"div",
					null,
					createElement("button", { type: "button", onClick: onRecordingStart }, "start-recording"),
					createElement("button", { type: "button", onClick: onRecordingStop }, "stop-recording"),
					createElement("button", { type: "button", onClick: onClose }, "close-voiceover"),
					createElement("button", { type: "button", onClick: onRecordingPause }, "pause-recording"),
					createElement(
						"button",
						{ type: "button", onClick: onRecordingResume },
						"resume-recording",
					),
					createElement(
						"button",
						{ type: "button", onClick: () => onComplete("voice", 4) },
						"complete-recording",
					),
				)
			: null,
}));

import { NewEditorShell } from "./NewEditorShell";

function makeDocument(): AxcutDocument {
	const document = createEmptyDocument({ projectId: "project_voiceover", title: "Voiceover" });
	document.project.primaryAssetId = "screen";
	const screenAsset: AxcutAsset = {
		id: "screen",
		kind: "video",
		label: "screen",
		originalPath: "/screen.mp4",
		durationSec: 10,
		cameraTrack: null,
	};
	const voiceAsset: AxcutAsset = {
		id: "voice",
		kind: "audio",
		label: "voice",
		originalPath: "/voice.webm",
		durationSec: 4,
		cameraTrack: null,
	};
	const clip: AxcutClip = {
		id: "clip",
		assetId: screenAsset.id,
		sourceStartSec: 0,
		sourceEndSec: 10,
		timelineStartSec: 0,
		timelineEndSec: 10,
		wordRefs: [],
		origin: "system",
		reason: "",
	};
	document.assets = [screenAsset, voiceAsset];
	document.timeline.clips = [clip];
	document.timeline.trimRanges = [
		{
			id: "trim",
			assetId: screenAsset.id,
			clipId: clip.id,
			startSec: 3,
			endSec: 5,
			reason: "",
			origin: "user",
		},
	];
	return document;
}

function renderShell() {
	return render(
		<TooltipProvider>
			<EditorDialogsProvider>
				<NewEditorShell />
			</EditorDialogsProvider>
		</TooltipProvider>,
	);
}

function prepareShell() {
	localStorage.clear();
	vi.clearAllMocks();
	(window as unknown as { electronAPI?: unknown }).electronAPI = {
		onAiEditionChatEvent: () => () => undefined,
		sendAiEditionChatPrompt: () => undefined,
		setTitleBarOverlay: () => undefined,
		setHasUnsavedChanges: () => undefined,
		onRequestCloseConfirm: () => () => undefined,
		onRequestSaveBeforeClose: () => () => undefined,
		sendCloseConfirmResponse: () => undefined,
		findRecordingCamera: () => Promise.resolve(null),
		preparePreviewAudioTrack: () => Promise.resolve(null),
		isAppPackaged: () => false,
	};
	Element.prototype.scrollTo = () => undefined;
	(globalThis as unknown as { ResizeObserver?: unknown }).ResizeObserver = class {
		observe = vi.fn();
		unobserve = vi.fn();
		disconnect = vi.fn();
	};
	const document = makeDocument();
	const saveDocument = vi.fn(async (next: AxcutDocument) => {
		useProjectStore.setState({
			document: next,
			revision: 2,
			dirty: true,
			lastSavedAt: new Date(),
		});
		return true;
	});
	useProjectStore.setState({
		projectId: document.project.id,
		document,
		revision: 1,
		status: "ready",
		error: null,
		sourceDurationSec: 10,
		currentTimeSec: 2,
		playing: false,
		dirty: false,
		lastSavedAt: new Date(),
		saveDocument,
	});
}

describe("NewEditorShell voiceover placement", () => {
	beforeEach(prepareShell);

	afterEach(() => {
		cleanup();
		localStorage.clear();
		useProjectStore.getState().clear();
	});

	it("adds a full-duration plain track across a cut and lets the cut mute its middle", async () => {
		const document = useProjectStore.getState().document;
		if (!document) throw new Error("document was not initialized");
		const rawClips = document.timeline.clips;
		renderShell();

		expect(mocks.nativePlaybackSync.mock.lastCall?.[2]).toHaveLength(2);
		fireEvent.click(screen.getByRole("button", { name: "open-voiceover" }));
		fireEvent.click(screen.getByRole("button", { name: "start-recording" }));

		expect(screen.getByTestId("preview-recording-mode")).toHaveAttribute("data-unedited", "true");
		expect(mocks.previewPlay).toHaveBeenCalledOnce();
		expect(mocks.nativePlaybackSync).toHaveBeenLastCalledWith(false, 2, rawClips, rawClips);

		act(() => {
			useProjectStore.setState({ currentTimeSec: 4 });
		});
		fireEvent.click(screen.getByRole("button", { name: "stop-recording" }));
		expect(mocks.nativePlaybackSync.mock.lastCall?.[2]).toHaveLength(2);
		fireEvent.click(screen.getByRole("button", { name: "complete-recording" }));

		await waitFor(() => {
			expect(useProjectStore.getState().document?.audioTracks).toHaveLength(1);
		});
		const updatedDocument = useProjectStore.getState().document;
		if (!updatedDocument) throw new Error("voiceover document was not saved");
		const [track] = updatedDocument.audioTracks;
		expect(track).toMatchObject({
			assetId: "voice",
			kind: "voiceover",
			startMs: 2_000,
			endMs: 6_000,
			durationSec: 4,
		});
		expect(track).not.toHaveProperty("recordingPlaybackMap");
		expect(buildSceneDescription(updatedDocument).audioTracks).toMatchObject([
			{ startSec: 2, trimStartSec: 0, trimEndSec: 1, kind: "voiceover" },
			{ startSec: 3, trimStartSec: 3, trimEndSec: 4, kind: "voiceover" },
		]);
	});
});

describe("paused voiceover preview", () => {
	beforeEach(prepareShell);
	afterEach(() => {
		cleanup();
		useProjectStore.getState().clear();
	});

	it.each([
		false,
		true,
	])("only stops playback on closing an active take (active=%s)", async (active) => {
		renderShell();
		await act(async () => {
			fireEvent.click(screen.getByText("toggle-preview"));
		});
		fireEvent.click(screen.getByText("open-voiceover"));
		if (active) {
			await act(async () => {
				fireEvent.click(screen.getByText("start-recording"));
			});
		}
		fireEvent.click(screen.getByText("close-voiceover"));
		expect(mocks.previewPause).toHaveBeenCalledTimes(active ? 1 : 0);
		expect(screen.queryByText("close-voiceover")).not.toBeInTheDocument();
	});

	it("freezes seeking and transport while paused, then keeps the original placement across resume", async () => {
		renderShell();
		fireEvent.click(screen.getByText("open-voiceover"));
		await act(async () => {
			fireEvent.click(screen.getByText("start-recording"));
		});
		act(() => {
			useProjectStore.setState({ currentTimeSec: 4 });
		});
		fireEvent.click(screen.getByText("pause-recording"));
		expect(mocks.previewPause).toHaveBeenCalledOnce();
		expect(screen.getByTestId("preview-recording-mode")).toHaveAttribute("data-unedited", "true");
		fireEvent.click(screen.getByText("seek-preview"));
		fireEvent.click(screen.getByText("toggle-preview"));
		expect(useProjectStore.getState().currentTimeSec).toBe(4);
		expect(mocks.previewPlay).toHaveBeenCalledOnce();
		await act(async () => {
			fireEvent.click(screen.getByText("resume-recording"));
		});
		expect(mocks.previewPlay).toHaveBeenCalledTimes(2);
		fireEvent.click(screen.getByText("stop-recording"));
		fireEvent.click(screen.getByText("complete-recording"));
		await waitFor(() => expect(useProjectStore.getState().document?.audioTracks).toHaveLength(1));
		expect(useProjectStore.getState().document?.audioTracks[0]).toMatchObject({
			startMs: 2000,
			endMs: 6000,
		});
	});

	it("re-pauses late playback if the take was stopped during an asynchronous resume", async () => {
		renderShell();
		fireEvent.click(screen.getByText("open-voiceover"));
		await act(async () => {
			fireEvent.click(screen.getByText("start-recording"));
		});
		fireEvent.click(screen.getByText("pause-recording"));
		let finish!: () => void;
		mocks.previewPlay.mockImplementationOnce(
			() =>
				new Promise<void>((resolve) => {
					finish = resolve;
				}),
		);
		fireEvent.click(screen.getByText("resume-recording"));
		fireEvent.click(screen.getByText("stop-recording"));
		await act(async () => {
			finish();
		});
		expect(mocks.previewPause).toHaveBeenCalledTimes(3);
		expect(screen.getByTestId("preview-recording-mode")).toHaveAttribute("data-unedited", "false");
	});

	it("does not restart preview when a paused take has reached the timeline end", async () => {
		renderShell();
		fireEvent.click(screen.getByText("open-voiceover"));
		await act(async () => {
			fireEvent.click(screen.getByText("start-recording"));
		});
		fireEvent.click(screen.getByText("pause-recording"));
		act(() => {
			useProjectStore.setState({ currentTimeSec: 10 });
		});
		await act(async () => {
			fireEvent.click(screen.getByText("resume-recording"));
		});
		expect(mocks.previewPlay).toHaveBeenCalledTimes(1);
	});
});
