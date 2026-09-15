// @vitest-environment jsdom
// Guards the right-rail settings panes against untranslated strings creeping
// back in: every pane used to hardcode its English labels (title, tabs, slider
// labels, help popover), so switching the app locale left the whole inspector
// in English. These render each pane under a non-English locale and assert the
// localized text is what actually reaches the DOM.

import "@testing-library/jest-dom";
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { I18nProvider } from "@/contexts/I18nContext";
import { LOCALE_STORAGE_KEY } from "@/i18n/config";
import { CursorPane, LayoutPane, TranscriptPane, VideoEffectsPane } from "./RightPanes";

function renderIn(locale: string, ui: ReactElement) {
	localStorage.setItem(LOCALE_STORAGE_KEY, locale);
	return render(<I18nProvider>{ui}</I18nProvider>);
}

beforeEach(() => {
	localStorage.clear();
});

afterEach(() => {
	cleanup();
	localStorage.clear();
});

describe("right-rail panes are localized", () => {
	it("renders the background section of the effects pane in French", () => {
		// Background stopped being its own pane when the two facets merged; it is a section
		// of the effects pane now, so the same strings must survive under the new heading.
		renderIn("fr", <VideoEffectsPane />);
		expect(screen.getByRole("heading", { name: "Composition" })).toBeInTheDocument();
		expect(screen.getByText("Arrière-plan")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Aide" })).toBeInTheDocument();
	});

	it("renders the inline background picker in French", () => {
		// The picker is in the pane, not behind a trigger: it went into a popover to keep
		// the frame sliders above the fold, and came back out once its grid was given a
		// height budget of its own to scroll inside. So its strings are in the DOM on
		// render, with nothing to click first.
		renderIn("fr", <VideoEffectsPane />);
		expect(screen.getByRole("button", { name: "Téléverser une image" })).toBeInTheDocument();
		// wallpaper swatches interpolate their index through the catalog
		expect(screen.getByRole("button", { name: "Fond 1" })).toBeInTheDocument();
	});

	it("renders the video-effects pane in Spanish", () => {
		renderIn("es", <VideoEffectsPane />);
		expect(screen.getByRole("heading", { name: "Composición" })).toBeInTheDocument();
		expect(screen.getByText("Desenfoque de movimiento")).toBeInTheDocument();
		expect(screen.getByText("Sombra")).toBeInTheDocument();
		// the merged pane's own section headers
		expect(screen.getByText("Marco")).toBeInTheDocument();
		expect(screen.getByText("Movimiento")).toBeInTheDocument();
	});

	it("renders the layout pane in Japanese", () => {
		renderIn("ja-JP", <LayoutPane />);
		expect(screen.getByRole("heading", { name: "カメラレイアウト" })).toBeInTheDocument();
		// the preset <option> labels come from the shared layout.* catalog
		expect(screen.getByRole("option", { name: "ピクチャーインピクチャ" })).toBeInTheDocument();
	});

	it("renders the cursor pane in French", () => {
		renderIn("fr", <CursorPane />);
		expect(screen.getByRole("heading", { name: "Curseur" })).toBeInTheDocument();
		expect(screen.getByText("Lissage")).toBeInTheDocument();
		expect(screen.getByText("Rebond au clic")).toBeInTheDocument();
		expect(screen.getByText("Masquer si inactif")).toBeInTheDocument();
	});

	it("falls back to English when the locale is English", () => {
		renderIn("en", <VideoEffectsPane />);
		expect(screen.getByRole("heading", { name: "Composition" })).toBeInTheDocument();
		expect(screen.getByText("Blur BG")).toBeInTheDocument();
	});

	it("renders the transcript pane title as 'Transcription' in French", () => {
		const noop = () => {
			/* noop */
		};
		renderIn(
			"fr",
			<TranscriptPane
				clips={[]}
				audioTracks={[]}
				transcripts={[]}
				assets={[]}
				trimRanges={[]}
				busyAssetIds={[]}
				onSeek={noop}
				onTrimTimelineSpan={noop}
				onRemoveTrimRanges={noop}
				onSetWordText={noop}
				onInsertWord={noop}
				onRemoveWords={noop}
				onTranscribe={noop}
				canTranscribe={false}
				isTranscribing={false}
			/>,
		);
		expect(screen.getByRole("heading", { name: "Transcription" })).toBeInTheDocument();
	});

	it("renders the transcript pane title as 'Transcript' in English", () => {
		const noop = () => {
			/* noop */
		};
		renderIn(
			"en",
			<TranscriptPane
				clips={[]}
				audioTracks={[]}
				transcripts={[]}
				assets={[]}
				trimRanges={[]}
				busyAssetIds={[]}
				onSeek={noop}
				onTrimTimelineSpan={noop}
				onRemoveTrimRanges={noop}
				onSetWordText={noop}
				onInsertWord={noop}
				onRemoveWords={noop}
				onTranscribe={noop}
				canTranscribe={false}
				isTranscribing={false}
			/>,
		);
		expect(screen.getByRole("heading", { name: "Transcript" })).toBeInTheDocument();
	});
});
