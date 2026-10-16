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
