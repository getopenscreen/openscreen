// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { createElement, useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	previewPlay: vi.fn(() => Promise.resolve()),
	previewPause: vi.fn(),
	latestSeekTarget: null as {
		timeSec: number;
		isSource?: boolean;
		requestId: number;
		preservePlayback?: boolean;
	} | null,
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
	useI18n: () => ({
		locale: "en",
		setLocale: vi.fn(),
	}),
	useScopedT: () => (key: string) => key,
}));

vi.mock("./Preview", () => ({
	Preview: ({
		seekTarget,
		onVideoElement,
	}: {
		seekTarget: {
			timeSec: number;
			isSource?: boolean;
			requestId: number;
			preservePlayback?: boolean;
		} | null;
		onVideoElement: (element: HTMLVideoElement | null) => void;
	}) => {
		mocks.latestSeekTarget = seekTarget;
		useEffect(() => {
			const element = document.createElement("video");
			let paused = true;
			Object.defineProperty(element, "paused", {
				configurable: true,
				get: () => paused,
			});
			element.play = vi.fn(() => {
				paused = false;
				element.dispatchEvent(new Event("play"));
				return mocks.previewPlay();
			});
			element.pause = vi.fn(() => {
				paused = true;
				element.dispatchEvent(new Event("pause"));
				mocks.previewPause();
			});
			onVideoElement(element);
			return () => onVideoElement(null);
		}, [onVideoElement]);
		return createElement("div", {
			"data-testid": "preview-mock",
			"data-seek-target": JSON.stringify(seekTarget),
		});
	},
}));

import { TooltipProvider } from "@/components/ui/tooltip";
import { EditorDialogsProvider } from "@/contexts/EditorDialogsContext";
import type { AxcutAsset, AxcutClip, AxcutDocument } from "@/lib/ai-edition/schema";
import { createEmptyDocument } from "@/lib/ai-edition/schema";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import { NewEditorShell } from "./NewEditorShell";

function makeCrossAssetDocument(): AxcutDocument {
	const doc = createEmptyDocument({ projectId: "p1", title: "Cross-Asset Replay" });
	const asset1: AxcutAsset = {
		id: "a1",
		kind: "video",
		label: "a1",
		originalPath: "/a1.mp4",
		durationSec: 5,
		cameraTrack: null,
	};
	const asset2: AxcutAsset = {
		id: "a2",
		kind: "video",
		label: "a2",
		originalPath: "/a2.mp4",
		durationSec: 5,
		cameraTrack: null,
	};
	const clip1: AxcutClip = {
		id: "c1",
		assetId: "a1",
		sourceStartSec: 0,
		sourceEndSec: 5,
		timelineStartSec: 0,
		timelineEndSec: 5,
		wordRefs: [],
		origin: "user",
		reason: "",
	};
	const clip2: AxcutClip = {
		id: "c2",
		assetId: "a2",
		sourceStartSec: 0,
		sourceEndSec: 5,
		timelineStartSec: 5,
		timelineEndSec: 10,
		wordRefs: [],
		origin: "user",
		reason: "",
	};
	doc.assets = [asset1, asset2];
	doc.timeline.clips = [clip1, clip2];
	return doc;
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

describe("NewEditorShell togglePlay cross-asset replay", () => {
	beforeEach(() => {
		localStorage.clear();
		mocks.previewPlay.mockClear();
		mocks.previewPause.mockClear();
		mocks.latestSeekTarget = null;
		(window as unknown as { electronAPI?: unknown }).electronAPI = {
			onAiEditionChatEvent: () => () => {},
			setTitleBarOverlay: () => {},
			setHasUnsavedChanges: () => {},
			onRequestCloseConfirm: () => () => {},
			onRequestSaveBeforeClose: () => () => {},
			sendCloseConfirmResponse: () => {},
			findRecordingCamera: () => Promise.resolve(null),
			preparePreviewAudioTrack: () => Promise.resolve({ success: false, path: null }),
			readBinaryFile: () => Promise.resolve(new Uint8Array(0)),
			isAppPackaged: () => false,
		};
		Element.prototype.scrollTo = () => {};
		(globalThis as unknown as { ResizeObserver?: unknown }).ResizeObserver = class {
			observe() {}
			unobserve() {}
			disconnect() {}
		};
	});

	afterEach(() => {
		cleanup();
		(window as unknown as { electronAPI?: unknown }).electronAPI = undefined;
	});

	it("preserves playback intent when replaying across assets through togglePlay", async () => {
		const doc = makeCrossAssetDocument();
		useProjectStore.setState({
			document: doc,
			projectId: "p1",
			currentTimeSec: 10, // at the end of the timeline
			playing: false,
		});

		renderShell();

		// Trigger replay via Space shortcut (togglePlay)
		await act(async () => {
			fireEvent.keyDown(document.body, { key: " ", code: "Space" });
		});

		// 1. togglePlay must have initiated a seek to 0 carrying preservePlayback: true
		expect(mocks.latestSeekTarget).toMatchObject({
			timeSec: 0,
			preservePlayback: true,
		});

		// 2. togglePlay must have called play() to start playback
		expect(mocks.previewPlay).toHaveBeenCalledTimes(1);
		expect(useProjectStore.getState().currentTimeSec).toBe(0);
	});

	it("does not rewind to 0 when pressing play from an intermediate position after cross-asset seek", async () => {
		const doc = makeCrossAssetDocument();
		useProjectStore.setState({
			document: doc,
			projectId: "p1",
			currentTimeSec: 4, // in clip1 (0-5s), timeline ends at 10s
			playing: false,
		});

		renderShell();

		await act(async () => {
			fireEvent.keyDown(document.body, { key: " ", code: "Space" });
		});

		// Must NOT seek to 0
		expect(mocks.latestSeekTarget).toBeNull();
		expect(mocks.previewPlay).toHaveBeenCalledTimes(1);
		expect(useProjectStore.getState().currentTimeSec).toBe(4);
	});
});
