// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Dialog, DialogContent, DialogTitle } from "./dialog";
import { TOOLTIP_GAP_PX, Tooltip, TooltipProvider } from "./tooltip";

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
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

function renderTooltip(props: Partial<React.ComponentProps<typeof Tooltip>> = {}) {
	render(
		<TooltipProvider>
			<Tooltip content="Add a zoom at the playhead" {...props}>
				<button type="button">Zoom</button>
			</Tooltip>
		</TooltipProvider>,
	);
	return screen.getByRole("button", { name: "Zoom" });
}

// Radix draws the visible tooltip and a visually hidden `role="tooltip"` copy for assistive
// technology, so the styled node is found by its slot.
function visibleTooltip() {
	return document.querySelector<HTMLElement>('[data-slot="tooltip-content"]');
}

function popperWrapper() {
	return document.querySelector<HTMLElement>("[data-radix-popper-content-wrapper]");
}

/** Focus the way the keyboard gives it: after a Tab, so the trigger is `:focus-visible`. jsdom
 *  reads that from the last key, and ignores one sent to the element that had the focus. */
function focusByKeyboard(element: HTMLElement) {
	fireEvent.keyDown(window, { key: "Tab" });
	act(() => element.focus());
}

/** A mouse click: the pointer goes down, the browser focuses the button, the pointer comes up. */
function clickWithMouse(element: HTMLElement) {
	fireEvent.pointerDown(element);
	fireEvent.mouseDown(element);
	act(() => element.focus());
	fireEvent.pointerUp(element);
	fireEvent.mouseUp(element);
	fireEvent.click(element);
}

describe("Tooltip", () => {
	it("wraps long text and follows the text's own direction", () => {
		const button = renderTooltip();
		focusByKeyboard(button);

		const content = visibleTooltip();
		expect(content).toHaveAttribute("dir", "auto");
		expect(content?.className).toContain("max-w-[260px]");
		// Balanced lines, so a translation never ends on a single orphan word.
		expect(content?.className).toContain("text-balance");
		expect(content).toHaveTextContent("Add a zoom at the playhead");
	});

	it("renders a shortcut as its own left-to-right chip after the text", () => {
		const button = renderTooltip({ shortcut: "Ctrl + Z" });
		focusByKeyboard(button);

		const chip = visibleTooltip()?.querySelector("kbd");
		expect(chip).toHaveTextContent("Ctrl + Z");
		expect(chip).toHaveAttribute("dir", "ltr");
		// The chip is a sibling of the text, not part of the translated string.
		expect(chip?.previousSibling?.textContent).toBe("Add a zoom at the playhead");
	});

	it("draws no chip when there is no shortcut", () => {
		const button = renderTooltip();
		focusByKeyboard(button);

		expect(visibleTooltip()?.querySelector("kbd")).toBeNull();
	});

	// The eye reads the gap against the trigger's edge. It was 6px, which two dark surfaces make
	// look like overlap; the jsdom boxes are all zero-sized, so the offset is the whole translation.
	it("keeps a real gap between the trigger and the tooltip", async () => {
		expect(TOOLTIP_GAP_PX).toBe(8);
		const button = renderTooltip();
		focusByKeyboard(button);

		await waitFor(() => expect(popperWrapper()?.style.transform).toBe("translate(0px, -8px)"));
	});

	it("lets a trigger that sits inside a padded surface ask for a larger gap", async () => {
		const button = renderTooltip({ sideOffset: 8 + 28 });
		focusByKeyboard(button);

		await waitFor(() => expect(popperWrapper()?.style.transform).toBe("translate(0px, -36px)"));
	});

	it("opens 400 ms after the pointer arrives, not before", () => {
		vi.useFakeTimers();
		const button = renderTooltip();

		fireEvent.pointerMove(button);
		act(() => {
			vi.advanceTimersByTime(399);
		});
		expect(visibleTooltip()).toBeNull();

		act(() => {
			vi.advanceTimersByTime(1);
		});
		expect(visibleTooltip()).not.toBeNull();
	});

	it("opens at once on keyboard focus and describes the trigger", () => {
		const button = renderTooltip();
		focusByKeyboard(button);

		expect(visibleTooltip()).not.toBeNull();
		expect(button).toHaveAccessibleDescription("Add a zoom at the playhead");
	});

	it("closes on Escape", () => {
		vi.useFakeTimers();
		const button = renderTooltip();
		fireEvent.pointerMove(button);
		act(() => {
			vi.advanceTimersByTime(400);
		});
		expect(visibleTooltip()).not.toBeNull();

		fireEvent.keyDown(button, { key: "Escape" });
		expect(visibleTooltip()).toBeNull();
	});

	// Issue #1016. Focus comes back to a clicked control without a click: the window is switched
	// back to, a dialog returns it to its opener. Radix opened the tooltip then, and only a blur
	// closed it, so it stayed over the controls beside it.
	it("leaves no tooltip after a click, even when the focus comes back to it", () => {
		const button = renderTooltip();
		clickWithMouse(button);
		expect(visibleTooltip()).toBeNull();

		act(() => {
			button.blur();
			button.focus();
		});
		expect(button).toHaveFocus();
		expect(visibleTooltip()).toBeNull();
	});

	// v2.3.0-rc.1 e2e: the tooltip of the control just left stayed over the next one, and the next
	// one showed none. Radix kept it open while the pointer sat in the triangle towards it, and
	// blocked every other trigger meanwhile; on the click-through HUD no later move ever came.
	it("closes as the pointer leaves, and the neighbour's opens at once", () => {
		vi.useFakeTimers();
		render(
			<TooltipProvider>
				<Tooltip content="System audio: records what you hear">
					<button type="button">Audio</button>
				</Tooltip>
				<Tooltip content="Microphone: records your voice">
					<button type="button">Mic</button>
				</Tooltip>
			</TooltipProvider>,
		);
		const audio = screen.getByRole("button", { name: "Audio" });
		const mic = screen.getByRole("button", { name: "Mic" });
		fireEvent.pointerMove(audio);
		act(() => {
			vi.advanceTimersByTime(400);
		});
		expect(visibleTooltip()).toHaveTextContent("System audio");

		// No pointer move after the leave: the HUD's case, once the pointer is off the bar.
		fireEvent.pointerLeave(audio);
		act(() => {
			vi.advanceTimersByTime(200);
		});
		expect(visibleTooltip()).toBeNull();

		fireEvent.pointerMove(mic);
		expect(visibleTooltip()).toHaveTextContent("Microphone");
	});

	// v2.3.0-rc.1 e2e (macOS D1): the Edit-clip dialog's 180° tip opened at z 50, under the dialog.
	it("draws above the highest dialog layer", () => {
		vi.useFakeTimers();
		render(
			<Dialog open>
				<DialogContent aria-describedby={undefined}>
					<DialogTitle>Edit clip</DialogTitle>
					<TooltipProvider>
						<Tooltip content="Turn the picture upside down">
							<button type="button">180°</button>
						</Tooltip>
					</TooltipProvider>
				</DialogContent>
			</Dialog>,
		);
		const zOf = (element: Element) => Number(/\bz-\[(\d+)\]/.exec(element.className)?.[1] ?? 0);
		const dialogLayer = Math.max(...[...document.body.querySelectorAll("*")].map(zOf));
		expect(dialogLayer).toBeGreaterThanOrEqual(10000);

		fireEvent.pointerMove(screen.getByRole("button", { name: "180°" }));
		act(() => {
			vi.advanceTimersByTime(400);
		});
		const tooltip = visibleTooltip();
		expect(tooltip).not.toBeNull();
		expect(zOf(tooltip as HTMLElement)).toBeGreaterThan(dialogLayer);
	});
});
