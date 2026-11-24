import type { MessageBoxOptions, MessageBoxReturnValue } from "electron";
import type { AiEditionDeleteResult, AiEditionRecordingsDisposal } from "../src/native/contracts";

export type CloseConfirmResponse =
	| "save"
	| "discard"
	| "cancel"
	| {
			choice: "discard-project";
			projectId: string;
			recordings: AiEditionRecordingsDisposal;
	  };

const VALID_RECORDINGS_DISPOSALS = new Set<AiEditionRecordingsDisposal>([
	"keep",
	"trash",
	"permanent",
]);

export function isValidCloseConfirmResponse(value: unknown): value is CloseConfirmResponse {
	if (value === "save" || value === "discard" || value === "cancel") {
		return true;
	}
	if (!value || typeof value !== "object") {
		return false;
	}
	const candidate = value as Record<string, unknown>;
	return (
		candidate.choice === "discard-project" &&
		typeof candidate.projectId === "string" &&
		candidate.projectId.length > 0 &&
		typeof candidate.recordings === "string" &&
		VALID_RECORDINGS_DISPOSALS.has(candidate.recordings as AiEditionRecordingsDisposal)
	);
}

function redactPaths(message: string): string {
	return message
		.replace(/[A-Za-z]:\\(?:[^\\/:*?"<>|\r\n]+\\)*([^\\/:*?"<>|\r\n]*)/g, "…\\$1")
		.replace(/\/(?:[^/\0\s'"]+\/)+([^/\0\s'"]*)/g, "…/$1");
}

export interface CloseableEditorWindow {
	isDestroyed(): boolean;
	webContents: {
		id: number;
		send(channel: string, ...args: unknown[]): void;
	};
	once(event: "closed", listener: () => void): unknown;
	removeListener(event: "closed", listener: () => void): unknown;
}

export interface CloseIpcEvent {
	sender: { id: number };
}

export interface CloseIpcMain {
	on(channel: string, listener: (event: CloseIpcEvent, ...args: unknown[]) => void): unknown;
	removeListener(
		channel: string,
		listener: (event: CloseIpcEvent, ...args: unknown[]) => void,
	): unknown;
}

export interface EditorCloseControllerDeps {
	ipcMain: CloseIpcMain;
	deleteProject: (
		projectId: string,
		disposal: AiEditionRecordingsDisposal,
	) => Promise<AiEditionDeleteResult>;
	destroyViewsForSender: (senderId: number) => void;
	forceClose: (win: CloseableEditorWindow) => void;
	showMessageBox: (options: MessageBoxOptions) => Promise<MessageBoxReturnValue>;
	t: (namespace: "common" | "dialogs", key: string) => string;
	platform: NodeJS.Platform;
	onDiscardSettled: () => void;
}

export function createEditorCloseController(deps: EditorCloseControllerDeps) {
	let hasUnsavedChanges = false;
	let hasDiscardableProject = false;
	let isForceClosing = false;
	let isCloseConfirmInFlight = false;
	let pendingDiscard: Promise<void> | null = null;

	function waitForWindowClosed(win: CloseableEditorWindow): Promise<void> {
		if (win.isDestroyed()) return Promise.resolve();
		return new Promise((resolve) => {
			win.once("closed", resolve);
		});
	}

	async function performDiscard(
		win: CloseableEditorWindow,
		senderId: number,
		projectId: string,
		recordings: AiEditionRecordingsDisposal,
	): Promise<void> {
		try {
			// Release native Rust FFmpeg file handles before tearing down and deleting on Windows.
			deps.destroyViewsForSender(senderId);
			const closedPromise = waitForWindowClosed(win);
			deps.forceClose(win);
			await closedPromise;

			let result = await deps.deleteProject(projectId, recordings);
			if (!result.success && result.trashFailed && recordings === "trash") {
				const trashKey =
					deps.platform === "win32" ? "closeProject.recycleFailed" : "closeProject.trashFailed";
				const prompt = await deps.showMessageBox({
					type: "warning",
					title: deps.t("dialogs", "closeProject.discardErrorTitle"),
					message: deps.t("dialogs", trashKey),
					buttons: [
						deps.t("dialogs", "closeProject.deletePermanently"),
						deps.t("dialogs", "closeProject.keepProject"),
					],
					defaultId: 1,
					cancelId: 1,
					noLink: true,
				});
				if (prompt.response === 0) {
					result = await deps.deleteProject(projectId, "permanent");
				} else {
					return;
				}
			}
			if (!result.success) {
				await deps.showMessageBox({
					type: "error",
					title: deps.t("dialogs", "closeProject.discardErrorTitle"),
					message: redactPaths(result.error ?? "Failed to discard project."),
					buttons: [deps.t("common", "actions.close")],
					defaultId: 0,
					noLink: true,
				});
			}
		} catch (error) {
			await deps
				.showMessageBox({
					type: "error",
					title: deps.t("dialogs", "closeProject.discardErrorTitle"),
					message: redactPaths(error instanceof Error ? error.message : String(error)),
					buttons: [deps.t("common", "actions.close")],
					defaultId: 0,
					noLink: true,
				})
				.catch(() => undefined);
		} finally {
			pendingDiscard = null;
			deps.onDiscardSettled();
		}
	}

	return {
		setHasUnsavedChanges(value: boolean) {
			hasUnsavedChanges = value;
		},
		getHasUnsavedChanges() {
			return hasUnsavedChanges;
		},
		setHasDiscardableProject(value: boolean) {
			hasDiscardableProject = value;
		},
		getHasDiscardableProject() {
			return hasDiscardableProject;
		},
		isDiscarding() {
			return pendingDiscard !== null;
		},
		isForceClosingWindow() {
			return isForceClosing;
		},
		setForceClosing(value: boolean) {
			isForceClosing = value;
		},
		resetForNewEditorWindow() {
			hasUnsavedChanges = false;
			hasDiscardableProject = false;
			isCloseConfirmInFlight = false;
		},
		handleWindowClose(event: { preventDefault(): void }, win: CloseableEditorWindow | null) {
			if (
				isForceClosing ||
				isCloseConfirmInFlight ||
				(!hasUnsavedChanges && !hasDiscardableProject)
			) {
				return;
			}
			if (!win || win.isDestroyed()) return;

			event.preventDefault();
			isCloseConfirmInFlight = true;

			const senderId = win.webContents.id;

			const cleanupConfirm = () => {
				isCloseConfirmInFlight = false;
				deps.ipcMain.removeListener("close-confirm-response", onConfirmResponse);
				win.removeListener("closed", cleanupConfirm);
			};

			const onConfirmResponse = (ipcEvent: CloseIpcEvent, rawChoice: unknown) => {
				if (ipcEvent.sender.id !== senderId) return;
				cleanupConfirm();
				if (win.isDestroyed()) return;
				if (!isValidCloseConfirmResponse(rawChoice)) return;

				if (rawChoice === "save") {
					const cleanupSave = () => {
						deps.ipcMain.removeListener("save-before-close-done", onSaveDone);
						win.removeListener("closed", cleanupSave);
					};
					const onSaveDone = (saveEvent: CloseIpcEvent, shouldClose: unknown) => {
						if (saveEvent.sender.id !== senderId) return;
						cleanupSave();
						if (!shouldClose || win.isDestroyed()) return;
						deps.forceClose(win);
					};
					deps.ipcMain.on("save-before-close-done", onSaveDone);
					win.once("closed", cleanupSave);
					win.webContents.send("request-save-before-close");
					return;
				}

				if (rawChoice === "discard") {
					deps.forceClose(win);
					return;
				}

				if (typeof rawChoice === "object" && rawChoice.choice === "discard-project") {
					pendingDiscard = performDiscard(win, senderId, rawChoice.projectId, rawChoice.recordings);
				}
			};

			deps.ipcMain.on("close-confirm-response", onConfirmResponse);
			win.once("closed", cleanupConfirm);
			win.webContents.send("request-close-confirm");
		},
	};
}
