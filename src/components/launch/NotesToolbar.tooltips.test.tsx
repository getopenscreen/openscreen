// @vitest-environment jsdom
// The Notes toolbar keeps its names as the tooltips. Two buttons say more than a name:
// Mirror explains what the teleprompter mirror is for, and Play/Pause is one action button whose
// name and tooltip change together (no `aria-pressed`, see technical-documentation/engineering/tooltips.md).

import "@testing-library/jest-dom";
import { act, cleanup, render, screen } from "@testing-library/react";
import type { Editor } from "@tiptap/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { I18nProvider } from "@/contexts/I18nContext";
import { LOCALE_STORAGE_KEY } from "@/i18n/config";
import { NotesToolbar, type NotesToolbarProps } from "./NotesToolbar";

// jsdom has none, and a Radix tooltip measures its trigger when it opens.
class StubResizeObserver {
	observe() {
		return undefined;
	}
	unobserve() {
		return undefined;
	}
	disconnect() {
		return undefined;
	}
}

beforeEach(() => {
	vi.stubGlobal("ResizeObserver", StubResizeObserver);
	localStorage.clear();
	localStorage.setItem(LOCALE_STORAGE_KEY, "en");
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	localStorage.clear();
});

// Enough of an editor for the toolbar to render and enable the teleprompter controls. The
// formatting buttons are disabled by `formattingDisabled`, so `can()` is never asked.
const editor = {
	isActive: () => false,
	on: vi.fn(),
	off: vi.fn(),
} as unknown as Editor;

function renderToolbar(overrides: Partial<NotesToolbarProps> = {}) {
	render(
		<I18nProvider>
			<TooltipProvider>
				<NotesToolbar
					editor={editor}
					isPlaying={false}
					formattingDisabled
					speed={40}
					fontSize={16}
					mirrored={false}
					onTogglePlaying={vi.fn()}
					onDecreaseSpeed={vi.fn()}
					onIncreaseSpeed={vi.fn()}
					onDecreaseFontSize={vi.fn()}
					onIncreaseFontSize={vi.fn()}
					onToggleMirror={vi.fn()}
					{...overrides}
				/>
			</TooltipProvider>
		</I18nProvider>,
	);
}

// Radix draws the visible tooltip and a visually hidden `role="tooltip"` copy for assistive
// technology, so the styled node is found by its slot.
const visibleTooltip = () => document.querySelector('[data-slot="tooltip-content"]');

describe("NotesToolbar tooltips", () => {
	it("explains what Mirror is for and keeps its name", () => {
		renderToolbar();
		const mirror = screen.getByRole("button", { name: "Mirror horizontally" });
		act(() => mirror.focus());

		expect(visibleTooltip()).toHaveTextContent(
			"Flip the text left to right, to read it in a mirror",
		);
		expect(mirror).toHaveAccessibleDescription(
			"Flip the text left to right, to read it in a mirror",
		);
	});

	it("names Play by its action, in the name and the tooltip together, with no pressed state", () => {
		renderToolbar();
		const play = screen.getByRole("button", { name: "Start auto-scroll" });
		act(() => play.focus());

		expect(visibleTooltip()).toHaveTextContent("Start auto-scroll");
		expect(play).not.toHaveAttribute("aria-pressed");
	});

	it("names Pause by its action while it scrolls", () => {
		renderToolbar({ isPlaying: true });
		const pause = screen.getByRole("button", { name: "Pause auto-scroll" });
		act(() => pause.focus());

		expect(visibleTooltip()).toHaveTextContent("Pause auto-scroll");
		expect(pause).not.toHaveAttribute("aria-pressed");
	});

	it("keeps the plain name as the tooltip of a clear button", () => {
		renderToolbar();
		// The bold button is disabled while formatting is; the teleprompter size buttons are not.
		const bigger = screen.getByRole("button", { name: "Increase font size" });
		act(() => bigger.focus());

		expect(visibleTooltip()).toHaveTextContent("Increase font size");
	});
});
