// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { FloatingCameraPreview } from "./FloatingCameraPreview";

vi.mock("../../contexts/I18nContext", () => ({ useScopedT: () => (key: string) => key }));
afterEach(cleanup);

it("displays incoming frames and offers three bounded preview sizes", async () => {
	let frame: ((jpeg: string) => void) | undefined;
	const resize = vi.fn().mockResolvedValue(undefined);
	const unsubscribe = vi.fn();
	window.electronAPI = {
		onCameraPreviewFrame: (callback: (jpeg: string) => void) => {
			frame = callback;
			return unsubscribe;
		},
		resizeCameraPreview: resize,
	} as unknown as Window["electronAPI"];
	const view = render(<FloatingCameraPreview />);
	act(() => frame?.("data:image/jpeg;base64,frame"));
	expect(screen.getByAltText("floatingCamera.title").getAttribute("src")).toBe(
		"data:image/jpeg;base64,frame",
	);
	const larger = screen.getByRole("button", { name: "floatingCamera.larger" });
	const smaller = screen.getByRole("button", { name: "floatingCamera.smaller" });
	fireEvent.click(larger);
	await waitFor(() => expect((larger as HTMLButtonElement).disabled).toBe(true));
	expect(resize).toHaveBeenLastCalledWith(320);
	fireEvent.click(smaller);
	await waitFor(() => expect((larger as HTMLButtonElement).disabled).toBe(false));
	fireEvent.click(smaller);
	await waitFor(() => expect((smaller as HTMLButtonElement).disabled).toBe(true));
	expect(resize).toHaveBeenLastCalledWith(160);
	view.unmount();
	expect(unsubscribe).toHaveBeenCalledOnce();
});

it("shows the whole frame by default, and rounds only the Custom (square) preview", async () => {
	let changed:
		| ((prefs: { camShape: "square" | null; camRoundness: number | null }) => void)
		| undefined;
	const getRecordingPrefs = vi.fn().mockResolvedValue({ camShape: null, camRoundness: 0.4 });
	const unsubscribe = vi.fn();
	window.electronAPI = {
		onCameraPreviewFrame: () => () => undefined,
		getRecordingPrefs,
		onRecordingPrefsChanged: (
			callback: (prefs: { camShape: "square" | null; camRoundness: number | null }) => void,
		) => {
			changed = callback;
			return unsubscribe;
		},
	} as unknown as Window["electronAPI"];
	const view = render(<FloatingCameraPreview />);
	const preview = screen.getByTestId("floating-camera-preview");
	await waitFor(() => expect(getRecordingPrefs).toHaveBeenCalled());
	// Default: the stylesheet's corners, whatever roundness is stored.
	expect(preview.className).not.toContain("square");
	expect(preview.style.borderRadius).toBe("");

	act(() => changed?.({ camShape: "square", camRoundness: 1 }));
	expect(preview.className).toContain("square");
	// Half the roundness, as a percentage of the square box.
	expect(preview.style.borderRadius).toBe("50%");
	view.unmount();
	expect(unsubscribe).toHaveBeenCalledOnce();
});
