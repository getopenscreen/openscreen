import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
	dialog: { showMessageBox: vi.fn(), showSaveDialog: vi.fn(), showOpenDialog: vi.fn() },
}));

import { type BrowserWindow, dialog } from "electron";
import {
	markSheetless,
	messageBoxOwner,
	showOpenDialogOver,
	showSaveDialogOver,
} from "./messageBox";

function fakeWindow(destroyed = false) {
	return { isDestroyed: () => destroyed } as unknown as BrowserWindow;
}

describe("messageBoxOwner", () => {
	it("shows a transparent overlay's dialog unowned on macOS, where a sheet greys the whole window", () => {
		const hud = fakeWindow();
		markSheetless(hud);

		expect(messageBoxOwner(hud, "darwin")).toBeNull();
	});

	it("keeps the overlay as owner elsewhere, where an unowned dialog opens behind it", () => {
		const hud = fakeWindow();
		markSheetless(hud);

		expect(messageBoxOwner(hud, "win32")).toBe(hud);
		expect(messageBoxOwner(hud, "linux")).toBe(hud);
	});

	it("keeps an opaque window as owner on macOS", () => {
		const editor = fakeWindow();

		expect(messageBoxOwner(editor, "darwin")).toBe(editor);
	});

	it("never attaches to a missing or destroyed window", () => {
		expect(messageBoxOwner(null, "win32")).toBeNull();
		expect(messageBoxOwner(fakeWindow(true), "win32")).toBeNull();
	});
});

describe("file dialogs (#743)", () => {
	const realPlatform = process.platform;
	const pinPlatform = (platform: NodeJS.Platform) =>
		Object.defineProperty(process, "platform", { value: platform, configurable: true });

	afterEach(() => {
		pinPlatform(realPlatform);
		vi.clearAllMocks();
	});

	it("attaches the export save panel to the editor on macOS, so it cannot fall behind it", async () => {
		pinPlatform("darwin");
		const editor = fakeWindow();
		const options = { title: "Save Exported Video" };

		await showSaveDialogOver(editor, options);

		expect(dialog.showSaveDialog).toHaveBeenCalledWith(editor, options);
	});

	it("attaches open panels to their window on Windows and Linux too", async () => {
		const editor = fakeWindow();
		for (const platform of ["win32", "linux"] as const) {
			pinPlatform(platform);
			await showOpenDialogOver(editor, {});
			expect(dialog.showOpenDialog).toHaveBeenLastCalledWith(editor, {});
		}
	});

	it("shows the panel unowned for a sheetless overlay on macOS, or with no window", async () => {
		pinPlatform("darwin");
		const hud = fakeWindow();
		markSheetless(hud);

		await showOpenDialogOver(hud, {});
		await showSaveDialogOver(null, {});

		expect(dialog.showOpenDialog).toHaveBeenCalledWith({});
		expect(dialog.showSaveDialog).toHaveBeenCalledWith({});
	});
});
