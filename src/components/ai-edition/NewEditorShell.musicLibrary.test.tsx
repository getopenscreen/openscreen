// @vitest-environment jsdom
// The timeline's "Music library" entry opens nothing of its own: it reveals the inspector's
// audio facet, where the library is a section. A selected region or audio track takes over
// the inspector body, though, so revealing the facet underneath one changes nothing on
// screen. And a selected audio track is the NORMAL state here, because adding a bed selects
// it: the second visit to the library is the one that used to do nothing.
//
// This drives the whole shell rather than the timeline alone because the bug lives in the
// hand-off between the two. The timeline test pins that the entry calls its callback; only
// the shell can show what that callback puts on screen.

import "@testing-library/jest-dom";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

import { EditorDialogsProvider } from "@/contexts/EditorDialogsContext";
import { createAudioTrack, createEmptyDocument } from "@/lib/ai-edition/schema";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import { NewEditorShell } from "./NewEditorShell";

beforeEach(() => {
	(window as unknown as { electronAPI?: unknown }).electronAPI = {
		onAiEditionChatEvent: () => () => {
			/* unsubscribe */
		},
		setTitleBarOverlay: () => {
			/* no native titlebar */
		},
		setHasUnsavedChanges: () => {
			/* no window close guard */
		},
		onRequestCloseConfirm: () => () => {
			/* unsubscribe */
		},
		onRequestSaveBeforeClose: () => () => {
			/* unsubscribe */
		},
		sendCloseConfirmResponse: () => {
			/* nothing is closing this window */
		},
		findRecordingCamera: () => Promise.resolve(null),
		preparePreviewAudioTrack: () => Promise.resolve(null),
		isAppPackaged: () => false,
		// What the revealed library asks for as soon as it is on screen.
		listMusicCatalogue: () => Promise.resolve({ success: true, tracks: [] }),
	};
	Element.prototype.scrollTo = () => {
		/* no scrolling in jsdom */
	};
	(globalThis as unknown as { ResizeObserver?: unknown }).ResizeObserver = class {
		observe() {
			/* never fires: nothing has a layout in jsdom */
		}
		unobserve() {
			/* see observe */
		}
		disconnect() {
			/* see observe */
		}
	};
});

afterEach(() => {
	cleanup();
	act(() => {
		useProjectStore.setState({ document: null, selectedAudioTrackId: null });
	});
	(window as unknown as { electronAPI?: unknown }).electronAPI = undefined;
});

describe("NewEditorShell music library entry", () => {
	it("shows the library even while an audio track is selected", async () => {
		render(
			<EditorDialogsProvider>
				<NewEditorShell />
			</EditorDialogsProvider>,
		);

		const doc = createEmptyDocument({ projectId: "p", title: "t" });
		const bed = createAudioTrack({
			assetId: "a1",
			durationSec: 60,
			timelineStartSec: 0,
			spanSec: 60,
			kind: "music",
		});
		doc.audioTracks = [bed];
		act(() => {
			// The state a first add leaves behind: the new bed is the selection.
			useProjectStore.setState({ document: doc, selectedAudioTrackId: bed.id });
		});
		expect(screen.queryByText("audio.moreMusic")).toBeNull();

		await act(async () => {
			fireEvent.click(screen.getByLabelText("toolbar.addAudioTooltip"));
		});
		await act(async () => {
			fireEvent.click(screen.getByText("audio.musicLibrary"));
		});

		expect(useProjectStore.getState().selectedAudioTrackId).toBeNull();
		expect(await screen.findByText("audio.moreMusic")).toBeInTheDocument();
	});
});
