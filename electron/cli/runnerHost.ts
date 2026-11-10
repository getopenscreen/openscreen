// Runs the hidden renderer runners (record, export, sources, captions) and
// routes their IPC by window, so one process can run any number of them: the
// one-shot CLI runs one, the MCP server one per tool call.
//
// No `electron` import: the IPC surface and the window factory are handed in,
// so the routing stays unit-testable.

import { type FileHandle, mkdir, open, rename, rm } from "node:fs/promises";
import path from "node:path";
import type { IpcMain } from "electron";
import {
	audioRenderPath,
	type CliDoneResult,
	type CliExportFile,
	type CliExportRequest,
	type CliProgressEvent,
	type CliRequest,
	defaultExportPath,
	isAudioExportFormat,
} from "../../src/lib/cliContracts";

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
	/** The export's output while its runner writes it, open on `partialPath`. */
	partial?: Promise<FileHandle>;
}

/** Largest read or write a runner makes in one call. */
const MAX_FILE_CHUNK_BYTES = 64 * 1024 * 1024;

/** Where the runner writes this export, derived as the runner derives it. */
function exportOutPath(request: CliExportRequest): string {
	return request.outPath ?? defaultExportPath(request.projectPath, request.format ?? "mp4");
}

/** The output is written beside itself and renamed once whole: a mix reads the file it replaces. */
function partialPath(request: CliExportRequest): string {
	return `${exportOutPath(request)}.part`;
}

/** The file of its own export a runner names by role. It never passes a path. */
function exportFilePath(request: CliExportRequest, file: unknown): string {
	if (file === ("output" satisfies CliExportFile)) return exportOutPath(request);
	if (file === ("render" satisfies CliExportFile) && isAudioExportFormat(request.format)) {
		return audioRenderPath(exportOutPath(request));
	}
	throw new Error(`Not a file of this export: ${String(file)}`);
}

/** Drops an output the runner did not commit. */
async function discardPartial(run: PendingRun): Promise<void> {
	if (!run.partial || run.request.kind !== "export") return;
	const opening = run.partial;
	run.partial = undefined;
	await opening.then((handle) => handle.close()).catch(() => undefined);
	await rm(partialPath(run.request), { force: true }).catch(() => undefined);
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
	/** The export of the window that calls, and nobody else's. */
	const exportRunFor = (event: RunnerIpcEvent) => {
		const run = runFor(event);
		if (run?.request.kind !== "export") throw new Error("This window runs no export");
		return { run, request: run.request };
	};

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
		return discardPartial(run).then(() => run.resolve(result));
	});

	// The export runner reads its render and writes its output in chunks, so that neither
	// file is ever whole in the renderer (issue #1385).
	ipc.handle("cli-export-file-size", async (event, file: unknown) => {
		const { request } = exportRunFor(event);
		const handle = await open(exportFilePath(request, file), "r");
		try {
			return (await handle.stat()).size;
		} finally {
			await handle.close();
		}
	});
	ipc.handle(
		"cli-export-file-read",
		async (event, file: unknown, offset: unknown, length: unknown) => {
			const { request } = exportRunFor(event);
			const filePath = exportFilePath(request, file);
			if (
				!Number.isSafeInteger(offset) ||
				(offset as number) < 0 ||
				!Number.isSafeInteger(length) ||
				(length as number) <= 0 ||
				(length as number) > MAX_FILE_CHUNK_BYTES
			) {
				throw new Error("Invalid chunk range");
			}
			const handle = await open(filePath, "r");
			try {
				const buffer = Buffer.allocUnsafe(length as number);
				const { bytesRead } = await handle.read(buffer, 0, length as number, offset as number);
				return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + bytesRead);
			} finally {
				await handle.close();
			}
		},
	);
	ipc.handle("cli-export-file-write", async (event, data: unknown, position: unknown) => {
		const { run, request } = exportRunFor(event);
		const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
		if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_FILE_CHUNK_BYTES) {
			throw new Error("Invalid chunk");
		}
		if (!Number.isSafeInteger(position) || (position as number) < 0) {
			throw new Error("Invalid chunk position");
		}
		run.partial ??= mkdir(path.dirname(partialPath(request)), { recursive: true }).then(() =>
			open(partialPath(request), "w"),
		);
		const handle = await run.partial;
		await handle.write(bytes, 0, bytes.byteLength, position as number);
	});
	ipc.handle("cli-export-file-commit", async (event) => {
		const { run, request } = exportRunFor(event);
		if (!run.partial) throw new Error("This export wrote no output");
		const opening = run.partial;
		run.partial = undefined;
		await (await opening).close();
		await rename(partialPath(request), exportOutPath(request));
	});

	return {
		start(request: CliRequest, handlers: RunnerHandlers = {}): RunnerRun<W> {
			const window = openWindow(RUNNER_WINDOW_TYPES[request.kind]);
			const id = window.webContents.id;
			// Registered in the same tick the load starts in: the renderer cannot ask
			// for its request before this line has run.
			const reported = new Promise<CliDoneResult>((resolve) => {
				runs.set(id, { request, handlers, resolve });
			});
			// An audio export renders an MP4 beside its output that the runner cannot delete.
			const audioFormat =
				request.kind === "export" && isAudioExportFormat(request.format) ? request.format : null;
			const done =
				request.kind === "export" && audioFormat
					? reported.then(async (result) => {
							// Derived as the runner derives it: a failed run reports no outputPath.
							await rm(audioRenderPath(exportOutPath(request)), { force: true }).catch(
								() => undefined,
							);
							return result;
						})
					: reported;
			// A runner that never reports would otherwise hold its caller forever.
			const fail = (error: string) => {
				const run = runs.get(id);
				if (!run) return;
				runs.delete(id);
				void discardPartial(run).then(() => run.resolve({ success: false, error }));
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
