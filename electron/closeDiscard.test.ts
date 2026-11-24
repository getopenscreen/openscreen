import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	type CloseableEditorWindow,
	type CloseIpcEvent,
	createEditorCloseController,
	type EditorCloseControllerDeps,
	isValidCloseConfirmResponse,
} from "./closeDiscard";

class MockIpcMain extends EventEmitter {
	override on(channel: string, listener: (event: CloseIpcEvent, ...args: unknown[]) => void) {
		return super.on(channel, listener);
	}
	override removeListener(
		channel: string,
		listener: (event: CloseIpcEvent, ...args: unknown[]) => void,
	) {
		return super.removeListener(channel, listener);
	}
}

class MockWindow extends EventEmitter implements CloseableEditorWindow {
	destroyed = false;
	sent: Array<{ channel: string; args: unknown[] }> = [];
	webContents = {
		id: 101,
		send: (channel: string, ...args: unknown[]) => {
			this.sent.push({ channel, args });
		},
	};
	isDestroyed() {
		return this.destroyed;
	}
	closeNow() {
		this.destroyed = true;
		this.emit("closed");
	}
}

describe("isValidCloseConfirmResponse", () => {
	it("accepts legacy string choices and valid discard-project payloads", () => {
		expect(isValidCloseConfirmResponse("save")).toBe(true);
		expect(isValidCloseConfirmResponse("discard")).toBe(true);
		expect(isValidCloseConfirmResponse("cancel")).toBe(true);
		expect(
			isValidCloseConfirmResponse({
				choice: "discard-project",
				projectId: "proj_1",
				recordings: "trash",
			}),
		).toBe(true);
		expect(
			isValidCloseConfirmResponse({
				choice: "discard-project",
				projectId: "proj_1",
				recordings: "keep",
			}),
		).toBe(true);
	});

	it("rejects malformed payloads", () => {
		expect(isValidCloseConfirmResponse(null)).toBe(false);
		expect(isValidCloseConfirmResponse("unknown")).toBe(false);
		expect(
			isValidCloseConfirmResponse({
				choice: "discard-project",
				projectId: "",
				recordings: "trash",
			}),
		).toBe(false);
		expect(
			isValidCloseConfirmResponse({
				choice: "discard-project",
				projectId: "proj_1",
				recordings: "Trash",
			}),
		).toBe(false);
	});
});

describe("createEditorCloseController", () => {
	let ipcMain: MockIpcMain;
	let win: MockWindow;
	let deleteProject: ReturnType<typeof vi.fn<EditorCloseControllerDeps["deleteProject"]>>;
	let destroyViewsForSender: ReturnType<
		typeof vi.fn<EditorCloseControllerDeps["destroyViewsForSender"]>
	>;
	let forceClose: ReturnType<typeof vi.fn<EditorCloseControllerDeps["forceClose"]>>;
	let showMessageBox: ReturnType<typeof vi.fn<EditorCloseControllerDeps["showMessageBox"]>>;
	let onDiscardSettled: ReturnType<typeof vi.fn<EditorCloseControllerDeps["onDiscardSettled"]>>;

	function makeController(platform: NodeJS.Platform = "linux") {
		return createEditorCloseController({
			ipcMain,
			deleteProject,
			destroyViewsForSender,
			forceClose,
			showMessageBox,
			t: (ns, key) => `${ns}:${key}`,
			platform,
			onDiscardSettled,
		});
	}

	beforeEach(() => {
		ipcMain = new MockIpcMain();
		win = new MockWindow();
		deleteProject = vi.fn<EditorCloseControllerDeps["deleteProject"]>(async () => ({
			success: true,
		}));
		destroyViewsForSender = vi.fn<EditorCloseControllerDeps["destroyViewsForSender"]>();
		forceClose = vi.fn<EditorCloseControllerDeps["forceClose"]>((w: CloseableEditorWindow) => {
			(w as MockWindow).closeNow();
		});
		showMessageBox = vi.fn<EditorCloseControllerDeps["showMessageBox"]>(async () => ({
			response: 1,
			checkboxChecked: false,
		}));
		onDiscardSettled = vi.fn<EditorCloseControllerDeps["onDiscardSettled"]>();
	});

	it("does not prevent close when clean and not discardable", () => {
		const controller = makeController();
		const event = { preventDefault: vi.fn() };
		controller.handleWindowClose(event, win);
		expect(event.preventDefault).not.toHaveBeenCalled();
		expect(win.sent).toEqual([]);
	});

	it("handles dirty save -> save-before-close-done(true/false)", () => {
		const controller = makeController();
		controller.setHasUnsavedChanges(true);

		const event1 = { preventDefault: vi.fn() };
		controller.handleWindowClose(event1, win);
		expect(event1.preventDefault).toHaveBeenCalledOnce();
		expect(win.sent[0]?.channel).toBe("request-close-confirm");

		ipcMain.emit("close-confirm-response", { sender: { id: 101 } }, "save");
		expect(win.sent[1]?.channel).toBe("request-save-before-close");

		ipcMain.emit("save-before-close-done", { sender: { id: 101 } }, false);
		expect(forceClose).not.toHaveBeenCalled();

		// A second save attempt after cancel/failure still prompts cleanly.
		const event2 = { preventDefault: vi.fn() };
		controller.handleWindowClose(event2, win);
		ipcMain.emit("close-confirm-response", { sender: { id: 101 } }, "save");
		ipcMain.emit("save-before-close-done", { sender: { id: 101 } }, true);
		expect(forceClose).toHaveBeenCalledWith(win);
	});

	it("handles dirty discard without deleting project", () => {
		const controller = makeController();
		controller.setHasUnsavedChanges(true);
		const event = { preventDefault: vi.fn() };

		controller.handleWindowClose(event, win);
		ipcMain.emit("close-confirm-response", { sender: { id: 101 } }, "discard");

		expect(forceClose).toHaveBeenCalledWith(win);
		expect(deleteProject).not.toHaveBeenCalled();
	});

	it("keeps window open on cancel and resets in-flight guard", () => {
		const controller = makeController();
		controller.setHasDiscardableProject(true);
		const event = { preventDefault: vi.fn() };

		controller.handleWindowClose(event, win);
		expect(event.preventDefault).toHaveBeenCalledOnce();
		ipcMain.emit("close-confirm-response", { sender: { id: 101 } }, "cancel");
		expect(forceClose).not.toHaveBeenCalled();

		// Can prompt again on next close click.
		const event2 = { preventDefault: vi.fn() };
		controller.handleWindowClose(event2, win);
		expect(event2.preventDefault).toHaveBeenCalledOnce();
	});

	it("discards project after destroying views and closing window", async () => {
		const order: string[] = [];
		destroyViewsForSender.mockImplementation(() => order.push("destroyViews"));
		forceClose.mockImplementation((w: CloseableEditorWindow) => {
			order.push("forceClose");
			(w as MockWindow).closeNow();
		});
		let resolveDelete!: (val: { success: boolean }) => void;
		deleteProject.mockImplementation(
			() =>
				new Promise((resolve) => {
					order.push("deleteProject");
					resolveDelete = resolve;
				}),
		);

		const controller = makeController();
		controller.setHasDiscardableProject(true);
		const event = { preventDefault: vi.fn() };

		controller.handleWindowClose(event, win);
		ipcMain.emit(
			"close-confirm-response",
			{ sender: { id: 101 } },
			{ choice: "discard-project", projectId: "proj_fresh", recordings: "trash" },
		);

		await vi.waitFor(() => expect(deleteProject).toHaveBeenCalledWith("proj_fresh", "trash"));
		expect(order).toEqual(["destroyViews", "forceClose", "deleteProject"]);
		expect(controller.isDiscarding()).toBe(true);
		expect(onDiscardSettled).not.toHaveBeenCalled();

		resolveDelete({ success: true });
		await vi.waitFor(() => expect(onDiscardSettled).toHaveBeenCalledOnce());
		expect(controller.isDiscarding()).toBe(false);
		expect(showMessageBox).not.toHaveBeenCalled();
	});

	it("offers permanent deletion when trash fails and retries on confirm", async () => {
		deleteProject
			.mockResolvedValueOnce({ success: false, trashFailed: true, error: "no trash" })
			.mockResolvedValueOnce({ success: true });
		showMessageBox.mockResolvedValueOnce({ response: 0, checkboxChecked: false });

		const controller = makeController("win32");
		controller.setHasDiscardableProject(true);

		controller.handleWindowClose({ preventDefault: vi.fn() }, win);
		ipcMain.emit(
			"close-confirm-response",
			{ sender: { id: 101 } },
			{ choice: "discard-project", projectId: "proj_trash", recordings: "trash" },
		);

		await vi.waitFor(() => expect(onDiscardSettled).toHaveBeenCalledOnce());
		expect(showMessageBox).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "warning",
				message: "dialogs:closeProject.recycleFailed",
			}),
		);
		expect(deleteProject).toHaveBeenNthCalledWith(1, "proj_trash", "trash");
		expect(deleteProject).toHaveBeenNthCalledWith(2, "proj_trash", "permanent");
	});

	it("does not retry permanent deletion if user chooses Keep project on trashFailed", async () => {
		deleteProject.mockResolvedValueOnce({
			success: false,
			trashFailed: true,
			error: "no trash",
		});
		showMessageBox.mockResolvedValueOnce({ response: 1, checkboxChecked: false });

		const controller = makeController("linux");
		controller.setHasDiscardableProject(true);

		controller.handleWindowClose({ preventDefault: vi.fn() }, win);
		ipcMain.emit(
			"close-confirm-response",
			{ sender: { id: 101 } },
			{ choice: "discard-project", projectId: "proj_trash", recordings: "trash" },
		);

		await vi.waitFor(() => expect(onDiscardSettled).toHaveBeenCalledOnce());
		expect(deleteProject).toHaveBeenCalledTimes(1);
		expect(showMessageBox).toHaveBeenCalledTimes(1);
	});

	it("shows redacted error dialog on non-trash failure and still settles", async () => {
		deleteProject.mockResolvedValueOnce({
			success: false,
			error: "ENOENT: open 'C:\\Users\\alice\\project.openscreen'",
		});

		const controller = makeController("win32");
		controller.setHasDiscardableProject(true);

		controller.handleWindowClose({ preventDefault: vi.fn() }, win);
		ipcMain.emit(
			"close-confirm-response",
			{ sender: { id: 101 } },
			{ choice: "discard-project", projectId: "proj_err", recordings: "keep" },
		);

		await vi.waitFor(() => expect(onDiscardSettled).toHaveBeenCalledOnce());
		expect(showMessageBox).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "error",
				message: expect.stringContaining("…\\project.openscreen"),
			}),
		);
	});

	it("ignores invalid IPC payloads and resets if window closes mid-prompt", () => {
		const controller = makeController();
		controller.setHasDiscardableProject(true);

		controller.handleWindowClose({ preventDefault: vi.fn() }, win);
		ipcMain.emit("close-confirm-response", { sender: { id: 101 } }, { choice: "hack" });
		expect(deleteProject).not.toHaveBeenCalled();

		const win2 = new MockWindow();
		win2.webContents.id = 202;
		controller.handleWindowClose({ preventDefault: vi.fn() }, win2);
		win2.closeNow();

		const win3 = new MockWindow();
		win3.webContents.id = 303;
		const event3 = { preventDefault: vi.fn() };
		controller.handleWindowClose(event3, win3);
		expect(event3.preventDefault).toHaveBeenCalledOnce();
	});
});
