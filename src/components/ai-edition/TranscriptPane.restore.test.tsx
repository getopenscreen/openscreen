// @vitest-environment jsdom
// Bringing back a word cut from the transcript (#1012).
//
// Backspace strikes a word through and lays a trim over it; the bin that hovering the word
// reveals takes the trim away again. The bin exists only while the word is hovered, so it has
// to be reachable FROM the word. It used to sit in the text flow, where after a word ending
// its line it wrapped to the start of the next one: getting there meant leaving the word,
// and leaving the word took the bin away. jsdom has no layout, so these tests pin what keeps
// the bin beside the word (out of the flow, inside the hovered word) and the gesture itself.
//
// Ctrl/Cmd+Z is the other way back, and the transcript used to hand it to the browser's text
// undo, where a cut never lands.

import "@testing-library/jest-dom";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/contexts/I18nContext";
import {
	type AxcutAsset,
	type AxcutClip,
	type AxcutTranscript,
	type AxcutTrimRange,
	type AxcutWord,
	createEmptyDocument,
} from "@/lib/ai-edition/schema";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import { clearHistory, useUndoRedoShortcuts } from "@/lib/ai-edition/store/undo";
import { pushHistory } from "@/lib/ai-edition/store/undoStack";
import { TranscriptPane } from "./RightPanes";

vi.mock("@/native/client", () => ({ nativeBridgeClient: { aiEdition: {} } }));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

const ASSET: AxcutAsset = {
	id: "asset_1",
	kind: "video",
	label: "recording.mp4",
	originalPath: "/rec.mp4",
	durationSec: 3,
	cameraTrack: null,
};

const CLIP: AxcutClip = {
	id: "clip_1",
	assetId: "asset_1",
	sourceStartSec: 0,
	sourceEndSec: 3,
	timelineStartSec: 0,
	timelineEndSec: 3,
	wordRefs: [],
	origin: "user",
	reason: "",
};

// Contiguous, so no `[silence]` pill lands between them.
const WORDS: AxcutWord[] = [
	{ id: "w1", segmentId: "s", startSec: 0, endSec: 1, text: "Bonjour" },
	{ id: "w2", segmentId: "s", startSec: 1, endSec: 2, text: "Kubernetes" },
	{ id: "w3", segmentId: "s", startSec: 2, endSec: 3, text: "tout" },
];

const TRANSCRIPT: AxcutTranscript = {
	assetId: "asset_1",
	language: "fr",
	segments: [],
	words: WORDS,
};

// What Backspace on "Kubernetes" leaves behind.
const CUT: AxcutTrimRange = {
	id: "trim_1",
	assetId: "asset_1",
	startSec: 1,
	endSec: 2,
	reason: "",
	origin: "user",
};

function Pane({
	trimRanges,
	onRemoveTrimRanges,
}: {
	trimRanges: AxcutTrimRange[];
	onRemoveTrimRanges: (ids: string[]) => void;
}) {
	return (
		<TranscriptPane
			clips={[CLIP]}
			audioTracks={[]}
			transcripts={[TRANSCRIPT]}
			assets={[ASSET]}
			trimRanges={trimRanges}
			busyAssetIds={[]}
			onSeek={vi.fn()}
			onTrimTimelineSpan={vi.fn()}
			onRemoveTrimRanges={onRemoveTrimRanges}
			onSetWordText={vi.fn()}
			onInsertWord={vi.fn()}
			onRemoveWords={vi.fn()}
			onTranscribe={vi.fn()}
			canTranscribe
			isTranscribing={false}
		/>
	);
}

function wordEl(container: HTMLElement, id: string): HTMLElement {
	const el = container.querySelector<HTMLElement>(`[data-word-id="clip_1:${id}"]`);
	if (!el) throw new Error(`word ${id} not rendered`);
	return el;
}

afterEach(cleanup);

describe("restoring a cut word with the mouse", () => {
	// The shell drops the trims it is handed; holding them in state is the same round trip.
	function renderCut() {
		const onRemoveTrimRanges = vi.fn();
		function Harness() {
			const [trims, setTrims] = useState([CUT]);
			return (
				<Pane
					trimRanges={trims}
					onRemoveTrimRanges={(ids) => {
						onRemoveTrimRanges(ids);
						setTrims((current) => current.filter((trim) => !ids.includes(trim.id)));
					}}
				/>
			);
		}
		const view = render(
			<I18nProvider>
				<Harness />
			</I18nProvider>,
		);
		return { ...view, onRemoveTrimRanges };
	}

	it("shows the restore control on hover, keeps it on the way onto it, and restores", () => {
		const view = renderCut();
		const word = wordEl(view.container, "w2");
		expect(word).toHaveAttribute("data-skip-id", "trim_1");
		expect(view.queryByRole("button", { name: 'Restore "Kubernetes"' })).toBeNull();

		fireEvent.mouseOver(word);
		const restore = view.getByRole("button", { name: 'Restore "Kubernetes"' });
		// Laid over the text beside the word, not inserted into it: in the flow it wrapped to
		// the next line after a word ending its line, out of the pointer's reach.
		expect(restore).toHaveStyle({ position: "absolute" });
		expect(word).toHaveStyle({ position: "relative" });
		expect(word).toContainElement(restore);

		// The pointer leaving the word FOR the control is not leaving the word.
		fireEvent.mouseOut(word, { relatedTarget: restore });
		fireEvent.mouseOver(restore, { relatedTarget: word });
		expect(restore).toBeInTheDocument();

		fireEvent.click(restore);
		expect(view.onRemoveTrimRanges).toHaveBeenCalledWith(["trim_1"]);
		expect(wordEl(view.container, "w2")).not.toHaveAttribute("data-skip-id");
		expect(view.queryByRole("button", { name: 'Restore "Kubernetes"' })).toBeNull();
	});

	it("takes the control away once the pointer moves on to another word", () => {
		const view = renderCut();
		const word = wordEl(view.container, "w2");
		fireEvent.mouseOver(word);
		const restore = view.getByRole("button", { name: 'Restore "Kubernetes"' });

		fireEvent.mouseOut(restore, { relatedTarget: wordEl(view.container, "w3") });
		expect(view.queryByRole("button", { name: 'Restore "Kubernetes"' })).toBeNull();
		expect(view.onRemoveTrimRanges).not.toHaveBeenCalled();
	});
});

describe("restoring a cut word with Ctrl/Cmd+Z in the transcript", () => {
	const PROJECT_ID = "project_1";
	const empty = createEmptyDocument({ projectId: PROJECT_ID, title: "t" });
	const cut = { ...empty, timeline: { ...empty.timeline, trimRanges: [CUT] } };

	beforeEach(() => {
		useProjectStore.getState().clear();
		clearHistory();
		// The Backspace that made the cut, as the store records it.
		pushHistory({ projectId: PROJECT_ID, doc: empty });
		useProjectStore.setState({ projectId: PROJECT_ID, document: cut });
	});

	// The shell's wiring: the trims come from the document, undo walks the document.
	function renderFromStore() {
		let undoHandlers: ReturnType<typeof useUndoRedoShortcuts> | undefined;
		function Harness() {
			undoHandlers = useUndoRedoShortcuts(() => undefined);
			const trims = useProjectStore((s) => s.document?.timeline.trimRanges ?? []);
			return <Pane trimRanges={trims} onRemoveTrimRanges={vi.fn()} />;
		}
		const view = render(
			<I18nProvider>
				<Harness />
			</I18nProvider>,
		);
		const editor = view.getByRole("textbox");
		// jsdom does not implement `isContentEditable`; a browser reports it for the block,
		// and it is what used to hand the shortcut to the browser's text undo, which never
		// sees a transcript edit.
		Object.defineProperty(editor, "isContentEditable", { value: true });
		editor.focus();
		if (!undoHandlers) throw new Error("undo handlers not mounted");
		return { ...view, editor, runUndo: undoHandlers.runUndo };
	}

	it("undoes the cut from the keyboard (Windows and Linux)", () => {
		const view = renderFromStore();
		expect(wordEl(view.container, "w2")).toHaveAttribute("data-skip-id", "trim_1");

		fireEvent.keyDown(view.editor, { key: "z", ctrlKey: true });

		expect(wordEl(view.container, "w2")).not.toHaveAttribute("data-skip-id");
	});

	it("undoes the cut from the Edit menu, Cmd+Z's only route on macOS", () => {
		const view = renderFromStore();
		expect(window.document.activeElement).toBe(view.editor);

		act(() => view.runUndo());

		expect(wordEl(view.container, "w2")).not.toHaveAttribute("data-skip-id");
	});
});
