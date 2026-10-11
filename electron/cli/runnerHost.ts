// Runs the hidden renderer runners (record, export, sources, captions) and
// routes their IPC by window, so one process can run any number of them: the
// one-shot CLI runs one, the MCP server one per tool call.
//
// No `electron` import: the IPC surface and the window factory are handed in,
// so the routing stays unit-testable.

import type { IpcMain } from "electron";
import type { CliDoneResult, CliProgressEvent, CliRequest } from "../../src/lib/cliContracts";

/** The slice of a BrowserWindow this needs. */
export interface RunnerWindow {
	isDestroyed(): boolean;
	destroy(): void;
	webContents: {
		id: number;
		once(event: "destroyed", listener: () => void): unknown;
		on(
			event: "render-process-gone",
			listener: (event: unknown, details: { reason: string }) => void,
		): unknown;
		on(
			event: "did-fail-load",
			listener: (
				event: unknown,
				errorCode: number,
				errorDescription: string,
				validatedURL: string,
				isMainFrame: boolean,
			) => void,
		): unknown;
	};
}

interface RunnerIpcEvent {
	sender: { id: number };
}

/** The slice of `ipcMain` this needs. */
export type RunnerIpc = Pick<IpcMain, "handle" | "on">;

export interface RunnerHandlers {
	/** The renderer asked for its request: it booted. */
	onRequest?(): void;
	onLog?(level: string, message: string): void;
	onProgress?(progress: CliProgressEvent): void;
}

export interface RunnerRun<W> {
	window: W;
	/** The runner's own result. A window that closes, crashes or fails to load fails the run. */
	done: Promise<CliDoneResult>;
	/** Closes the runner's window: a long-lived caller does once it has the result. */
	close(): void;
}

interface PendingRun {
	request: CliRequest;
	handlers: RunnerHandlers;
	resolve(result: CliDoneResult): void;
}

export const RUNNER_WINDOW_TYPES = {
	export: "cli-export",
	record: "cli-record",
	sources: "cli-sources",
	captions: "cli-captions",
} as const satisfies Record<CliRequest["kind"], string>;

export function createRunnerHost<W extends RunnerWindow>(
	ipc: RunnerIpc,
	openWindow: (windowType: string) => W,
) {
	const runs = new Map<number, PendingRun>();
	const runFor = (event: RunnerIpcEvent) => runs.get(event.sender.id);

	ipc.handle("cli-get-request", (event) => {
		const run = runFor(event);
		run?.handlers.onRequest?.();
		return run?.request ?? null;
	});
	ipc.on("cli-log", (event, level: string, message: string) => {
		runFor(event)?.handlers.onLog?.(level, message);
	});
	ipc.on("cli-progress", (event, progress: CliProgressEvent) => {
		runFor(event)?.handlers.onProgress?.(progress);
	});
	ipc.handle("cli-done", (event, result: CliDoneResult) => {
		const run = runFor(event);
		if (!run) return;
		runs.delete(event.sender.id);
		run.resolve(result);
	});

	return {
		start(request: CliRequest, handlers: RunnerHandlers = {}): RunnerRun<W> {
			const window = openWindow(RUNNER_WINDOW_TYPES[request.kind]);
			const id = window.webContents.id;
			// Registered in the same tick the load starts in: the renderer cannot ask
			// for its request before this line has run.
			const done = new Promise<CliDoneResult>((resolve) => {
				runs.set(id, { request, handlers, resolve });
			});
			// A runner that never reports would otherwise hold its caller forever.
			const fail = (error: string) => {
				const run = runs.get(id);
				if (!run) return;
				runs.delete(id);
				run.resolve({ success: false, error });
			};
			window.webContents.once("destroyed", () =>
				fail("The runner window closed before it finished"),
			);
			window.webContents.on("render-process-gone", (_event, details) =>
				fail(`Renderer crashed: ${details.reason}`),
			);
			window.webContents.on("did-fail-load", (_event, code, description, _url, isMainFrame) => {
				if (isMainFrame) fail(`Failed to load runner window: ${description} (${code})`);
			});
			return {
				window,
				done,
				close: () => {
					if (!window.isDestroyed()) window.destroy();
				},
			};
		},
	};
}
