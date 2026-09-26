// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ZOOM_DEPTH_SCALES, type ZoomDepth } from "@/components/video-editor/types";

// The pane is only reachable with a project open and a zoom region selected, so drive the
// control directly. The translator echoes keys, as in `SpeedControl.test.tsx`.
vi.mock("@/contexts/I18nContext", () => ({
	useScopedT: () => (key: string, vars?: Record<string, unknown>) =>
		vars ? `${key}:${Object.values(vars).join(",")}` : key,
}));

const toastError = vi.fn();
vi.mock("sonner", () => ({ toast: { error: (message: string) => toastError(message) } }));

import { ZoomLevelControl } from "./FloatingInspector";

// Never reached by the preset tests: a scale the table has is written as its depth.
const updateZoomCustomScale = vi.fn(async (_id: string, _scale: number) => true);

function renderControl(depth: ZoomDepth, customScale?: number) {
	const updateZoomDepth = vi.fn(async (_id: string, _depth: ZoomDepth) => true);
	render(
		<ZoomLevelControl
			region={{ id: "z1", depth, customScale }}
			tl={{ updateZoomDepth, updateZoomCustomScale }}
		/>,
	);
	const group = screen.getByRole("group", { name: "zoom.level" });
	const buttons = screen.getAllByRole("button");
	const field = screen.getByRole("textbox", { name: "zoom.customScale" });
	return { updateZoomDepth, group, buttons, field };
}

/**
 * The same control with the pane's half of the loop in place: in the editor `updateZoomDepth`
 * writes the region and the pane re-renders with the new `depth`, so the pressed button moves
 * under the keyboard. Stepping is only coherent if that feedback exists — with a frozen prop
 * every arrow would keep counting from the level the control opened on.
 */
function renderControlled(initial: ZoomDepth) {
	const updateZoomDepth = vi.fn(async (_id: string, _depth: ZoomDepth) => true);
	function Harness() {
		const [depth, setDepth] = useState<ZoomDepth>(initial);
		return (
			<ZoomLevelControl
				region={{ id: "z1", depth }}
				tl={{
					updateZoomCustomScale,
					updateZoomDepth: (id, next) => {
						// Synchronously, so the re-render lands inside the `fireEvent` that caused it:
						// the next keystroke in a test then sees the same DOM a user's would.
						updateZoomDepth(id, next);
						setDepth(next);
						return Promise.resolve(true);
					},
				}}
			/>
		);
	}
	render(<Harness />);
	const group = screen.getByRole("group", { name: "zoom.level" });
	const buttons = screen.getAllByRole("button");
	const focusLevel = (depth: ZoomDepth) => (buttons[depth - 2] as HTMLButtonElement).focus();
	return { updateZoomDepth, group, buttons, focusLevel };
}

describe("ZoomLevelControl", () => {
	beforeEach(() => {
		toastError.mockClear();
		updateZoomCustomScale.mockClear();
	});

	it("renders four presets, labelled with the table value, current one pressed", () => {
		const { buttons, field } = renderControl(3);
		expect(buttons.map((b) => b.textContent)).toEqual(
			([2, 3, 4, 5] as const).map((d) => `${ZOOM_DEPTH_SCALES[d]}×`),
		);
		expect(buttons.map((b) => b.getAttribute("aria-pressed"))).toEqual([
			"false",
			"true",
			"false",
			"false",
		]);
		expect(field).toHaveAttribute("placeholder", "1.8×");
	});

	// The ends of the table and every custom level live in the field, not the row.
	it("presses no preset for a level outside the row, and shows it in the field", () => {
		const { buttons, field } = renderControl(3, 2.75);
		expect(buttons.every((b) => b.getAttribute("aria-pressed") === "false")).toBe(true);
		expect(field).toHaveAttribute("placeholder", "2.75×");
	});

	it("commits a typed level as a custom scale, on Enter or blur and only once", () => {
		const { updateZoomDepth, field } = renderControl(3);
		fireEvent.change(field, { target: { value: "2,5×" } });
		fireEvent.keyDown(field, { key: "Enter" });
		fireEvent.blur(field);
		expect(updateZoomCustomScale).toHaveBeenCalledTimes(1);
		expect(updateZoomCustomScale).toHaveBeenCalledWith("z1", 2.5);
		expect(updateZoomDepth).not.toHaveBeenCalled();
		expect(field).toHaveValue("");
	});

	// A document keeps naming its presets, whether they were clicked or typed.
	it("writes a typed level the table has as its depth", () => {
		const { updateZoomDepth, field } = renderControl(3);
		fireEvent.change(field, { target: { value: "1.25" } });
		fireEvent.blur(field);
		expect(updateZoomDepth).toHaveBeenCalledWith("z1", 1);
		expect(updateZoomCustomScale).not.toHaveBeenCalled();
	});

	it("refuses a level outside the renderer's range and says so", () => {
		const { updateZoomDepth, field } = renderControl(3);
		fireEvent.change(field, { target: { value: "8" } });
		fireEvent.blur(field);
		expect(toastError).toHaveBeenCalledWith("zoom.customScaleRange:1,5");
		expect(updateZoomCustomScale).not.toHaveBeenCalled();
		expect(updateZoomDepth).not.toHaveBeenCalled();
	});

	it("hides the levels that would blur this clip, and refuses them typed", () => {
		const updateZoomDepth = vi.fn(async (_id: string, _depth: ZoomDepth) => true);
		render(
			<ZoomLevelControl
				region={{ id: "z1", depth: 3 }}
				tl={{ updateZoomDepth, updateZoomCustomScale }}
				maxScale={2.5}
			/>,
		);
		expect(screen.getAllByRole("button")).toHaveLength(3);

		const field = screen.getByRole("textbox", { name: "zoom.customScale" });
		fireEvent.change(field, { target: { value: "3" } });
		fireEvent.blur(field);
		expect(toastError).toHaveBeenCalledWith("zoom.customScaleRange:1,2.5");
		expect(updateZoomCustomScale).not.toHaveBeenCalled();
		expect(updateZoomDepth).not.toHaveBeenCalled();
	});

	it("drops the row when no preset is within reach", () => {
		render(
			<ZoomLevelControl
				region={{ id: "z1", depth: 1 }}
				tl={{ updateZoomDepth: vi.fn(), updateZoomCustomScale }}
				maxScale={1.3}
			/>,
		);
		expect(screen.queryByRole("group", { name: "zoom.level" })).toBeNull();
		expect(screen.getByRole("textbox", { name: "zoom.customScale" })).toBeInTheDocument();
	});

	it("offers every level when all are within reach", () => {
		renderControl(3);
		expect(screen.getAllByRole("button")).toHaveLength(4);
	});

	it("ignores an unparseable draft without touching the region", () => {
		const { updateZoomDepth, field } = renderControl(3);
		fireEvent.change(field, { target: { value: "abc" } });
		fireEvent.blur(field);
		expect(toastError).not.toHaveBeenCalled();
		expect(updateZoomCustomScale).not.toHaveBeenCalled();
		expect(updateZoomDepth).not.toHaveBeenCalled();
	});

	it("commits a level in one click", () => {
		const { updateZoomDepth, buttons } = renderControl(3);
		fireEvent.click(buttons[3] as HTMLButtonElement);
		expect(updateZoomDepth).toHaveBeenCalledTimes(1);
		expect(updateZoomDepth).toHaveBeenCalledWith("z1", 5);
	});

	it("does not write when the current level is clicked again", () => {
		// A no-op edit would still land a save and an undo entry.
		const { updateZoomDepth, buttons } = renderControl(3);
		fireEvent.click(buttons[1] as HTMLButtonElement);
		expect(updateZoomDepth).not.toHaveBeenCalled();
	});

	// The other half of that guard: undo/redo and the agent write the region without going
	// through this control, so a request of ours must never outlive the prop. The moment the
	// region says something else, that is the level to compare against.
	it("follows the region when the level is changed from elsewhere", async () => {
		const updateZoomDepth = vi.fn(async (_id: string, _depth: ZoomDepth) => true);
		const { rerender } = render(
			<ZoomLevelControl
				region={{ id: "z1", depth: 3 }}
				tl={{ updateZoomDepth, updateZoomCustomScale }}
			/>,
		);
		fireEvent.click(screen.getAllByRole("button")[3] as HTMLButtonElement);
		expect(updateZoomDepth).toHaveBeenCalledWith("z1", 5);
		await act(async () => {
			// Let the request settle so the follow-effect is allowed to copy the prop.
		});

		// An undo lands on 2 instead of the 5 this control asked for.
		rerender(
			<ZoomLevelControl
				region={{ id: "z1", depth: 2 }}
				tl={{ updateZoomDepth, updateZoomCustomScale }}
			/>,
		);
		fireEvent.click(screen.getAllByRole("button")[0] as HTMLButtonElement);
		expect(updateZoomDepth).toHaveBeenCalledTimes(1);

		fireEvent.click(screen.getAllByRole("button")[3] as HTMLButtonElement);
		expect(updateZoomDepth).toHaveBeenCalledTimes(2);
		expect(updateZoomDepth).toHaveBeenLastCalledWith("z1", 5);
	});

	it("steps to the neighbouring level with the arrow keys and moves focus with it", () => {
		const { updateZoomDepth, group, buttons, focusLevel } = renderControlled(3);
		focusLevel(3);
		fireEvent.keyDown(group, { key: "ArrowRight" });
		expect(updateZoomDepth).toHaveBeenLastCalledWith("z1", 4);
		expect(buttons[2]).toHaveFocus();
		fireEvent.keyDown(group, { key: "ArrowDown" });
		expect(updateZoomDepth).toHaveBeenLastCalledWith("z1", 5);
		expect(buttons[3]).toHaveFocus();
		fireEvent.keyDown(group, { key: "ArrowLeft" });
		expect(updateZoomDepth).toHaveBeenLastCalledWith("z1", 4);
		fireEvent.keyDown(group, { key: "ArrowUp" });
		expect(updateZoomDepth).toHaveBeenLastCalledWith("z1", 3);
		expect(buttons[1]).toHaveFocus();
		expect(updateZoomDepth).toHaveBeenCalledTimes(4);
		expect(buttons[1]).toHaveAttribute("aria-pressed", "true");
	});

	// Every level is a Tab stop, so focus can sit on a level that is not the selected one.
	// Counting from the selection there moved focus the wrong way across the row.
	it("steps from the button that has focus, not from the selected level", () => {
		const { updateZoomDepth, group, buttons, focusLevel } = renderControlled(2);
		focusLevel(4);
		fireEvent.keyDown(group, { key: "ArrowRight" });
		expect(buttons[3]).toHaveFocus();
		expect(updateZoomDepth).toHaveBeenCalledWith("z1", 5);
	});

	// `updateZoomDepth` writes the document, so the pressed state only catches up a tick later.
	// Focus moves in the keystroke itself, which is why holding an arrow down keeps advancing
	// instead of re-applying the same step against a `depth` prop that has not landed yet.
	it("keeps stepping while the write is still in flight", () => {
		const updateZoomDepth = vi.fn(async (_id: string, _depth: ZoomDepth) => true);
		function Harness() {
			const [depth, setDepth] = useState<ZoomDepth>(3);
			return (
				<ZoomLevelControl
					region={{ id: "z1", depth }}
					tl={{
						updateZoomCustomScale,
						updateZoomDepth: async (id, next) => {
							await updateZoomDepth(id, next);
							setDepth(next);
							return true;
						},
					}}
				/>
			);
		}
		render(<Harness />);
		const group = screen.getByRole("group", { name: "zoom.level" });
		const buttons = screen.getAllByRole("button");
		(buttons[1] as HTMLButtonElement).focus();
		fireEvent.keyDown(group, { key: "ArrowRight" });
		fireEvent.keyDown(group, { key: "ArrowRight" });
		expect(updateZoomDepth.mock.calls.map(([, depth]) => depth)).toEqual([4, 5]);
		expect(buttons[3]).toHaveFocus();
	});

	// The mirror image of the test above, and the one that catches a stale read: stepping
	// BACK to where the region started. The guard that makes re-pressing the current level a
	// no-op has to compare against what was last asked for, not against a `depth` prop that
	// still says 3 because the first write has not landed -- or the user's second keystroke
	// is dropped and the level stays on 4.
	it("does not drop a step back while the first write is still in flight", () => {
		const updateZoomDepth = vi.fn(async (_id: string, _depth: ZoomDepth) => true);
		function Harness() {
			const [depth, setDepth] = useState<ZoomDepth>(3);
			return (
				<ZoomLevelControl
					region={{ id: "z1", depth }}
					tl={{
						updateZoomCustomScale,
						updateZoomDepth: async (id, next) => {
							await updateZoomDepth(id, next);
							setDepth(next);
							return true;
						},
					}}
				/>
			);
		}
		render(<Harness />);
		const group = screen.getByRole("group", { name: "zoom.level" });
		const buttons = screen.getAllByRole("button");
		(buttons[1] as HTMLButtonElement).focus();
		fireEvent.keyDown(group, { key: "ArrowRight" });
		fireEvent.keyDown(group, { key: "ArrowLeft" });
		expect(updateZoomDepth.mock.calls.map(([, depth]) => depth)).toEqual([4, 3]);
		expect(buttons[1]).toHaveFocus();
	});

	// `saveDocument` writes the returned document into the store and only then
	// resolves, so an earlier request can echo back while a later one is still in
	// flight. Copying that echo into the no-op guard made ArrowLeft look like a
	// re-press of the current level: 3 → 4 → 5, 4 lands, ArrowLeft dropped, and
	// the level stayed on 5 with focus on 4.
	it("does not treat an earlier in-flight write as the latest request", async () => {
		const resolvers: Array<() => void> = [];
		const updateZoomDepth = vi.fn((_id: string, _depth: ZoomDepth) => {
			return new Promise<boolean>((resolve) => {
				resolvers.push(() => resolve(true));
			});
		});
		function Harness() {
			const [depth, setDepth] = useState<ZoomDepth>(3);
			return (
				<ZoomLevelControl
					region={{ id: "z1", depth }}
					tl={{
						updateZoomCustomScale,
						updateZoomDepth: (id, next) => {
							const pending = updateZoomDepth(id, next);
							void pending.then(() => setDepth(next));
							return pending;
						},
					}}
				/>
			);
		}
		render(<Harness />);
		const group = screen.getByRole("group", { name: "zoom.level" });
		const buttons = screen.getAllByRole("button");
		(buttons[1] as HTMLButtonElement).focus();
		fireEvent.keyDown(group, { key: "ArrowRight" });
		fireEvent.keyDown(group, { key: "ArrowRight" });
		expect(updateZoomDepth.mock.calls.map(([, depth]) => depth)).toEqual([4, 5]);
		expect(resolvers).toHaveLength(2);

		await act(async () => {
			resolvers[0]!();
		});
		// The row shows the latest request, not the echo of the older one.
		expect(buttons[3]).toHaveAttribute("aria-pressed", "true");
		expect(buttons[3]).toHaveFocus();

		fireEvent.keyDown(group, { key: "ArrowLeft" });
		expect(updateZoomDepth.mock.calls.map(([, depth]) => depth)).toEqual([4, 5, 4]);
		expect(buttons[2]).toHaveFocus();
	});

	// Depth values repeat, so an older request landing on 4 must not look like
	// the later request for 4 has confirmed, or the 5 in between is treated as
	// an external write and the latest 4 is lost.
	it("does not treat an older request for the same depth as the latest one", async () => {
		const resolvers: Array<() => void> = [];
		const updateZoomDepth = vi.fn((_id: string, _depth: ZoomDepth) => {
			return new Promise<boolean>((resolve) => {
				resolvers.push(() => resolve(true));
			});
		});
		function Harness() {
			const [depth, setDepth] = useState<ZoomDepth>(3);
			return (
				<ZoomLevelControl
					region={{ id: "z1", depth }}
					tl={{
						updateZoomCustomScale,
						updateZoomDepth: (id, next) => {
							const pending = updateZoomDepth(id, next);
							void pending.then(() => setDepth(next));
							return pending;
						},
					}}
				/>
			);
		}
		render(<Harness />);
		const group = screen.getByRole("group", { name: "zoom.level" });
		const buttons = screen.getAllByRole("button");
		(buttons[1] as HTMLButtonElement).focus();
		fireEvent.keyDown(group, { key: "ArrowRight" });
		fireEvent.keyDown(group, { key: "ArrowRight" });
		fireEvent.keyDown(group, { key: "ArrowLeft" });
		expect(updateZoomDepth.mock.calls.map(([, depth]) => depth)).toEqual([4, 5, 4]);

		await act(async () => {
			resolvers[0]!();
		});
		await act(async () => {
			resolvers[1]!();
		});
		fireEvent.click(buttons[3] as HTMLButtonElement);
		expect(updateZoomDepth.mock.calls.map(([, depth]) => depth)).toEqual([4, 5, 4, 5]);
	});

	it("does not leak a pending request onto a different zoom region", async () => {
		const updateZoomDepth = vi.fn(async (_id: string, _depth: ZoomDepth) => true);
		const { rerender } = render(
			<ZoomLevelControl
				region={{ id: "A", depth: 3 }}
				tl={{ updateZoomDepth, updateZoomCustomScale }}
			/>,
		);
		fireEvent.click(screen.getAllByRole("button")[3] as HTMLButtonElement);
		expect(updateZoomDepth).toHaveBeenCalledWith("A", 5);

		rerender(
			<ZoomLevelControl
				region={{ id: "B", depth: 3 }}
				tl={{ updateZoomDepth, updateZoomCustomScale }}
			/>,
		);
		fireEvent.click(screen.getAllByRole("button")[3] as HTMLButtonElement);
		expect(updateZoomDepth).toHaveBeenLastCalledWith("B", 5);
		expect(updateZoomDepth).toHaveBeenCalledTimes(2);
	});

	it("follows an undo after rapid steps have all settled", async () => {
		const updateZoomDepth = vi.fn(async (_id: string, _depth: ZoomDepth) => true);
		const { rerender } = render(
			<ZoomLevelControl
				region={{ id: "z1", depth: 3 }}
				tl={{ updateZoomDepth, updateZoomCustomScale }}
			/>,
		);
		const buttons = screen.getAllByRole("button");
		fireEvent.click(buttons[2] as HTMLButtonElement);
		fireEvent.click(buttons[3] as HTMLButtonElement);
		expect(updateZoomDepth.mock.calls.map(([, depth]) => depth)).toEqual([4, 5]);
		await act(async () => {
			// both generations must drain, or the follow-effect stays blocked
		});

		rerender(
			<ZoomLevelControl
				region={{ id: "z1", depth: 4 }}
				tl={{ updateZoomDepth, updateZoomCustomScale }}
			/>,
		);
		fireEvent.click(buttons[3] as HTMLButtonElement);
		expect(updateZoomDepth).toHaveBeenCalledTimes(3);
		expect(updateZoomDepth).toHaveBeenLastCalledWith("z1", 5);
	});

	it("retries the same level after a failed save", async () => {
		const updateZoomDepth = vi.fn(async (_id: string, _depth: ZoomDepth) => false);
		render(
			<ZoomLevelControl
				region={{ id: "z1", depth: 3 }}
				tl={{ updateZoomDepth, updateZoomCustomScale }}
			/>,
		);
		const buttons = screen.getAllByRole("button");
		fireEvent.click(buttons[3] as HTMLButtonElement);
		await act(async () => {
			// settle the failed write so the same target is not stuck as current
		});
		// The row hands the level back to the document while nothing is pending.
		expect(buttons[1]).toHaveAttribute("aria-pressed", "true");
		fireEvent.click(buttons[3] as HTMLButtonElement);
		expect(updateZoomDepth).toHaveBeenCalledTimes(2);
		expect(updateZoomDepth).toHaveBeenLastCalledWith("z1", 5);
	});

	it("clamps at the lowest level instead of wrapping", () => {
		const { updateZoomDepth, group, buttons, focusLevel } = renderControlled(2);
		focusLevel(2);
		fireEvent.keyDown(group, { key: "ArrowLeft" });
		expect(updateZoomDepth).not.toHaveBeenCalled();
		expect(buttons[0]).toHaveFocus();
	});

	it("clamps at the highest level instead of wrapping", () => {
		const { updateZoomDepth, group, buttons, focusLevel } = renderControlled(5);
		focusLevel(5);
		fireEvent.keyDown(group, { key: "ArrowRight" });
		expect(updateZoomDepth).not.toHaveBeenCalled();
		expect(buttons[3]).toHaveFocus();
	});

	it("keeps its own keys off the window listener, and lets every other key through", () => {
		// The editor shell listens on WINDOW, above React's root container: ArrowLeft/ArrowRight
		// seek the playhead there and Space is play/pause. Space matters most — the shell
		// `preventDefault()`s it, which cancels the button's own activation, so an unstopped
		// Space changed no level and started playback instead.
		//
		// What this pins is the propagation rule, which is where the bug was. jsdom does not
		// dispatch a button's native activation for Space at all, so "Space commits the focused
		// level" is only provable in a browser, where it was checked against the running editor.
		const onWindowKey = vi.fn();
		window.addEventListener("keydown", onWindowKey);
		try {
			const { group } = renderControlled(3);
			for (const key of ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", " ", "Enter"]) {
				fireEvent.keyDown(group, { key });
			}
			expect(onWindowKey).not.toHaveBeenCalled();

			// Keys the group ignores still get there, or the editor shortcuts would be dead.
			fireEvent.keyDown(group, { key: "z" });
			fireEvent.keyDown(group, { key: "Tab" });
			expect(onWindowKey).toHaveBeenCalledTimes(2);
		} finally {
			window.removeEventListener("keydown", onWindowKey);
		}
	});

	// `preventDefault()` on the activation keys would cancel the button's own click, which is
	// exactly how the shell broke Space in the first place.
	it("does not cancel the default action of the activation keys", () => {
		const { group } = renderControlled(3);
		for (const key of ["Enter", " "]) {
			const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
			group.dispatchEvent(event);
			expect(event.defaultPrevented).toBe(false);
		}
	});
});
