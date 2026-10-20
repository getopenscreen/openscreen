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
	previewPlay: vi.fn(async () => undefined),
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
				element.pause = vi.fn();
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
	V4Timeline: ({ onAddVoiceover }: { onAddVoiceover: () => void }) =>
		createElement("button", { type: "button", onClick: onAddVoiceover }, "open-voiceover"),
}));

vi.mock("./v4/AddAudioLayerDialog", () => ({
	AddAudioLayerDialog: ({
		open,
		onComplete,
		onRecordingStart,
		onRecordingStop,
	}: {
		open: boolean;
		onComplete: (assetId: string, durationSec: number) => void;
		onRecordingStart: () => void | Promise<void>;
		onRecordingStop: () => void;
	}) =>
		open
			? createElement(
					"div",
					null,
					createElement("button", { type: "button", onClick: onRecordingStart }, "start-recording"),
					createElement("button", { type: "button", onClick: onRecordingStop }, "stop-recording"),
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

describe("NewEditorShell voiceover placement", () => {
	beforeEach(() => {
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
	});

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
