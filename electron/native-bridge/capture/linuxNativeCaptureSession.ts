import { type ChildProcessByStdio, spawn } from "node:child_process";
import fs from "node:fs/promises";
import type { Readable, Writable } from "node:stream";
import type { NativeLinuxCaptureSource } from "../../../src/lib/nativeLinuxRecording";
import type { CursorRecordingData } from "../../../src/native/contracts";
import { salvageNativeMacCapture } from "../../recording/nativeMacCaptureSalvage";
import {
	type CursorPauseRange,
	compactCursorTelemetryPauseRanges,
} from "../cursor/recording/cursorPauseRanges";
import {
	NdjsonLineReader,
	PipeWireCursorAccumulator,
	type PipeWireHelperEvent,
} from "../cursor/recording/pipeWireCursorAccumulator";
import { findLinuxCaptureHelperPath } from "../cursor/recording/pipeWireCursorRecordingSession";

/**
 * Drives the Linux capture helper for a full recording: video, audio and cursor
 * telemetry from one backend: direct X11 capture, or ONE Wayland portal session.
 *
 * WHY ONE SESSION MATTERS ENOUGH TO BUILD THIS. `SelectSources` may be called
 * once per portal session, so a second process means a second picker. Before
 * this, Linux users picked a source twice — once for Chromium's
 * `getDisplayMedia` and once for the cursor helper — and the two captures could
 * legitimately be of different things, because each picker was answered
 * separately. That is also why the cursor overlay never lined up: the telemetry
 * described one stream and the pixels came from another.
 *
 * TIMEOUTS. `ready` arrives in milliseconds and means the helper loaded
 * libpipewire and reached the portal. `capture-started` cannot arrive until a
 * human has clicked through the compositor's dialog, which has no upper bound —
 * so the picker is deliberately NOT on a timer. The caller shows its own UI for
 * that wait; a timeout there would cancel recordings whose user was merely
 * reading the dialog. Once the picker has answered, the first frame IS bounded:
 * see [`FIRST_FRAME_TIMEOUT_MS`].
 */

const READY_TIMEOUT_MS = 5_000;
const STOP_TIMEOUT_MS = 15_000;
/**
 * How long the first frame may take once the picker has answered (#1101).
 *
 * Normal start-up after the answer is well under that: connect the stream,
 * negotiate a format (twice when a DMA-BUF allocation failure falls back to
 * shared memory, #1069), skip up to eight crop-less frames, probe the encoder
 * ladder. The helper's own give-ups land inside it too — 60 failed imports in a
 * row is 1–2 s — so a helper that CAN say what went wrong does, and this only
 * catches a stream that stays silent. Without it, frames the shim never
 * delivers leave the HUD waiting forever, with nothing on screen to say so.
 */
const FIRST_FRAME_TIMEOUT_MS = 10_000;
/**
 * How long the portal's picker takes to leave the screen once it is answered. A take
 * armed sooner had the dialog's closing animation in its first frame (seen on GNOME
 * Wayland after Restart, the one start with no countdown in between): mutter animates
 * a closing window for 150 ms, and the screencast stream lags it by a frame or two.
 */
const PICKER_CLOSE_MS = 500;
/**
 * The most of the helper's output [`helperOutput`] keeps, in UTF-8 bytes: the 64 KiB
 * Save Diagnostics writes of each helper. Only the newest is kept, as on Windows and
 * macOS.
 */
const HELPER_OUTPUT_MAX_BYTES = 64 * 1024;

export interface LinuxCaptureConfig {
	outputPath: string;
	/** An explicit app/CLI selection for the direct X11 backend only. */
	source?: NativeLinuxCaptureSource;
	cursorMode: "metadata" | "embedded";
	fps: number;
	bitrate?: number;
	audio: {
		system: { enabled: boolean };
		microphone: { enabled: boolean; deviceName?: string; gain: number };
	};
	maxCursorSamples: number;
	/**
	 * Negotiate the portal and stop there, until [`arm`] is called.
	 *
	 * Splits "the user has chosen what to share" from "pixels are flowing" so a
	 * countdown can sit between them. Without it the countdown runs first and the
	 * picker appears afterwards, which is backwards: the picker's wait has no
	 * upper bound, so the countdown finishes while the user is still reading a
	 * dialog they have not been shown yet.
	 */
	deferStart?: boolean;
}

/** What the portal handed over. `undefined` means the backend did not say. */
export type LinuxCaptureSourceKind = "monitor" | "window" | "virtual";

export interface LinuxCaptureResult {
	path: string;
	durationMs: number;
	frames: number;
	droppedFrames: number;
	cursor: CursorRecordingData;
	/** What the portal actually granted, when it said. */
	sourceKind?: LinuxCaptureSourceKind;
	videoEncoder?: string;
	/**
	 * Shown to the user when the editor opens the take. The session never sets it:
	 * the helper's own warnings are English diagnostics, so main words this from
	 * `audioLost` and `interrupted`.
	 */
	warning?: string;
	/** An audio stream the user asked for could not be opened, so the take lacks it. */
	audioLost?: true;
	/**
	 * The helper died before it was asked to stop, and this is the part of the take it
	 * had written by then. `durationMs` and `frames` describe what was recovered.
	 */
	interrupted?: true;
}

/** The user dismissed the portal's picker: a choice, not a failure to report. */
export function isPortalCancelled(error: unknown): boolean {
	return (error as { code?: unknown } | null)?.code === "portal-cancelled";
}

export class LinuxNativeCaptureSession {
	private readonly cursor: PipeWireCursorAccumulator;
	private readonly lines = new NdjsonLineReader();
	private process: ChildProcessByStdio<Writable, Readable, Readable> | null = null;

	private readyResolve: (() => void) | null = null;
	private readyReject: ((error: Error) => void) | null = null;
	private readyTimer: NodeJS.Timeout | null = null;

	private capturing = false;
	private startedResolve: (() => void) | null = null;
	private startedReject: ((error: Error) => void) | null = null;
	private firstFrameTimer: NodeJS.Timeout | null = null;

	private sourceSelected = false;
	private sourceSelectedAtMs = 0;
	private sourceSelectedResolve: (() => void) | null = null;
	private sourceSelectedReject: ((error: Error) => void) | null = null;
	/** The helper's error before any source was selected, for a wait registered after it. */
	private sourceSelectionError: Error | null = null;
	private armed = false;

	private stopped: LinuxCaptureResult | null = null;
	/** Set by `stop()` and `discard()`: from then on an exit is expected. */
	private stopRequested = false;
	private diedMidTake = false;
	/**
	 * Called when the helper exits mid-take without being asked to: it crashed, was
	 * killed, or lost its stream. Without it the HUD kept counting and the user found
	 * out only at Stop.
	 */
	onInterrupted: (() => void) | null = null;
	private stoppedResolve: (() => void) | null = null;
	private stoppedReject: ((error: Error) => void) | null = null;

	private sourceKind: LinuxCaptureSourceKind | undefined;
	private negotiatedCursorMode: LinuxCaptureConfig["cursorMode"] | undefined;
	private videoEncoder: string | undefined;
	private lastError: string | null = null;
	/** Why the helper exited, once it has: its error, or its exit code and signal. */
	private exitReason: string | null = null;
	private audioLost = false;
	private paused = false;
	private helperOutputText = "";
	private cursorRecordingStartMs = 0;
	private cursorPauseStartedAtMs: number | null = null;
	private cursorPauseRanges: CursorPauseRange[] = [];

	constructor(private readonly config: LinuxCaptureConfig) {
		this.cursor = new PipeWireCursorAccumulator(config.maxCursorSamples);
	}

	/**
	 * Spawns the helper and resolves once it reports `ready` — which is BEFORE
	 * the portal picker is raised. Call [`waitUntilCapturing`] to wait for the
	 * user to answer it.
	 */
	async start(): Promise<void> {
		const helperPath = findLinuxCaptureHelperPath();
		if (!helperPath) {
			throw new Error(
				"The Linux capture helper is not available. Build it with `npm run build:native:linux`.",
			);
		}

		this.cursor.reset(Date.now());
		this.lines.reset();
		this.cursorRecordingStartMs = 0;
		this.cursorPauseStartedAtMs = null;
		this.cursorPauseRanges = [];
		this.paused = false;

		const request = {
			outputPath: this.config.outputPath,
			...(this.config.source ? { source: this.config.source } : {}),
			cursorMode: this.config.cursorMode,
			video: {
				fps: this.config.fps,
				...(this.config.bitrate ? { bitrate: this.config.bitrate } : {}),
			},
			audio: this.config.audio,
			...(this.config.deferStart ? { deferStart: true } : {}),
		};

		const child = spawn(helperPath, [JSON.stringify(request)], {
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.process = child;

		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => this.handleStdout(chunk));
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk: string) => {
			this.appendHelperOutput(chunk);
			const message = chunk.trim();
			if (message) {
				console.error("[capture-linux]", message);
			}
		});
		child.once("exit", (code, signal) => {
			this.process = null;
			const reason =
				this.lastError ??
				`the Linux capture helper exited (code=${code ?? "null"}, signal=${signal ?? "null"})`;
			this.exitReason = reason;
			this.rejectReady(new Error(reason));
			this.startedReject?.(new Error(reason));
			this.startedReject = null;
			this.startedResolve = null;
			// A session held open across a countdown can die before it is armed —
			// the user revoking the share from the compositor's indicator, or
			// closing the window they picked. Whoever is waiting on the picker
			// has to learn that rather than wait forever.
			this.sourceSelectedReject?.(new Error(reason));
			this.sourceSelectedReject = null;
			this.sourceSelectedResolve = null;
			// A clean exit after `capture-stopped` is the normal path; anything
			// else means the file may not have its trailer.
			if (this.stopped) {
				this.stoppedResolve?.();
			} else {
				this.stoppedReject?.(new Error(reason));
			}
			this.stoppedResolve = null;
			this.stoppedReject = null;
			if (this.capturing && !this.stopRequested) {
				this.diedMidTake = true;
				console.error(`[capture-linux] the helper died mid-take: ${reason}`);
				this.onInterrupted?.();
			}
		});
		child.once("error", (error) => {
			this.process = null;
			this.rejectReady(error);
		});

		try {
			await new Promise<void>((resolve, reject) => {
				this.readyResolve = resolve;
				this.readyReject = reject;
				this.readyTimer = setTimeout(() => {
					this.rejectReady(new Error("Timed out waiting for the Linux capture helper"));
				}, READY_TIMEOUT_MS);
			});
		} catch (error) {
			this.kill();
			throw error;
		}
	}

	/**
	 * Resolves once the user has answered the compositor's picker.
	 *
	 * No timeout: a human is reading a dialog and there is no upper bound on
	 * that. Resolves immediately if the answer already arrived, so callers need
	 * not race the event.
	 *
	 * A session started WITHOUT `deferStart` still reports this — it simply
	 * arrives moments before capture rather than being waited on.
	 */
	waitUntilSourceSelected(): Promise<void> {
		if (this.sourceSelected) {
			return Promise.resolve();
		}
		// `ready` and the error can share one stdout chunk, both read before the caller
		// gets to wait: the cancel must still reach it, not the exit that follows.
		if (this.sourceSelectionError) {
			return Promise.reject(this.sourceSelectionError);
		}
		if (!this.process) {
			return Promise.reject(new Error("The Linux capture helper is not running."));
		}
		return new Promise<void>((resolve, reject) => {
			this.sourceSelectedResolve = resolve;
			this.sourceSelectedReject = reject;
		});
	}

	/**
	 * Releases a deferred session: connect to PipeWire and start encoding.
	 *
	 * Safe to call on a session that was not deferred (the helper ignores the
	 * verb) and safe to call twice, so a caller never has to track whether a
	 * prepare happened.
	 *
	 * Armed right after the portal's picker was answered, the release waits until
	 * the picker has left the screen (see [`PICKER_CLOSE_MS`]). After a countdown
	 * that wait is long over. Direct X11, which names its `source`, has no picker.
	 */
	arm() {
		if (this.armed) {
			return;
		}
		this.armed = true;
		const wait =
			this.config.source || !this.sourceSelected
				? 0
				: this.sourceSelectedAtMs + PICKER_CLOSE_MS - Date.now();
		if (wait <= 0) {
			this.write("record");
			return;
		}
		setTimeout(() => this.write("record"), wait);
	}

	/**
	 * Resolves when the first frame has been encoded. The picker's wait is not
	 * timed; the first frame after it is, and the helper is killed if it never
	 * comes. See the class doc.
	 */
	waitUntilCapturing(): Promise<void> {
		if (!this.process) {
			return Promise.reject(new Error("The Linux capture helper is not running."));
		}
		// A previously observed capture-started event must not bypass the helper
		// liveness check above.
		if (this.capturing) {
			return Promise.resolve();
		}
		return new Promise<void>((resolve, reject) => {
			const settle = () => {
				if (this.firstFrameTimer) {
					clearTimeout(this.firstFrameTimer);
					this.firstFrameTimer = null;
				}
			};
			this.startedResolve = () => {
				settle();
				resolve();
			};
			this.startedReject = (error) => {
				settle();
				reject(error);
			};
			this.startFirstFrameTimer();
		});
	}

	/**
	 * Starts the first-frame clock once a capture wait is pending AND the picker
	 * has answered, whichever comes last. Never earlier: a prepared session sits
	 * answered through the whole countdown, and the picker itself has no bound.
	 */
	private startFirstFrameTimer() {
		if (!this.sourceSelected || !this.startedReject || this.firstFrameTimer) {
			return;
		}
		this.firstFrameTimer = setTimeout(() => {
			this.firstFrameTimer = null;
			const reject = this.startedReject;
			this.startedResolve = null;
			this.startedReject = null;
			this.kill();
			reject?.(
				new Error(
					"OpenScreen could not start screen capture: the screen share delivered no " +
						`frame within ${FIRST_FRAME_TIMEOUT_MS / 1000} s.`,
				),
			);
		}, FIRST_FRAME_TIMEOUT_MS);
	}

	pause() {
		if (this.paused) {
			return;
		}
		this.write("pause");
		this.paused = true;
		this.cursorPauseStartedAtMs = Date.now();
	}

	resume() {
		if (!this.paused) {
			return;
		}
		this.write("resume");
		this.completeCursorPauseRange();
		this.paused = false;
	}

	private completeCursorPauseRange(endMs = Date.now()) {
		if (this.cursorPauseStartedAtMs === null || this.cursorRecordingStartMs <= 0) return;
		this.cursorPauseRanges.push({
			startMs: Math.max(0, this.cursorPauseStartedAtMs - this.cursorRecordingStartMs),
			endMs: Math.max(0, endMs - this.cursorRecordingStartMs),
		});
		this.cursorPauseStartedAtMs = null;
	}

	/**
	 * The cursor telemetry of a finished take, without its paused stretches. A take can
	 * end while paused, and the helper can end it before `stop()` runs: the open pause
	 * closes here, where every stopped snapshot is built.
	 */
	private stoppedCursorData(endMs?: number) {
		this.completeCursorPauseRange(endMs);
		return compactCursorTelemetryPauseRanges(this.cursor.toRecordingData(), this.cursorPauseRanges);
	}

	get isPaused() {
		return this.paused;
	}

	/**
	 * What the portal granted. Known from `stream-started`, so it is populated by
	 * the time [`waitUntilCapturing`] resolves.
	 *
	 * `undefined` means the backend did not report a kind — which is NOT the same
	 * as "a screen", and callers must not collapse the two. Guessing is what this
	 * whole field exists to stop.
	 */
	get grantedSourceKind(): LinuxCaptureSourceKind | undefined {
		return this.sourceKind;
	}

	/**
	 * The cursor mode the helper really negotiates, known once `start()` resolves.
	 * A portal without EMBEDDED gets METADATA instead (#1357), so the cursor has
	 * to be drawn by the editor even though the system cursor was asked for.
	 */
	get cursorMode(): LinuxCaptureConfig["cursorMode"] {
		return this.negotiatedCursorMode ?? this.config.cursorMode;
	}

	/**
	 * What the helper said in this session, for Save Diagnostics' `helperOutput.linux`:
	 * its stderr as written and every stdout line except `cursor-sample`, which comes
	 * at the capture rate and would push everything else out. Still readable after the
	 * helper exits, which is when a bug report asks for it.
	 */
	get helperOutput(): string {
		return this.helperOutputText;
	}

	private appendHelperOutput(text: string) {
		this.helperOutputText += text;
		if (Buffer.byteLength(this.helperOutputText, "utf8") <= HELPER_OUTPUT_MAX_BYTES) {
			return;
		}
		const bytes = Buffer.from(this.helperOutputText, "utf8");
		let start = bytes.length - HELPER_OUTPUT_MAX_BYTES;
		// A continuation byte (0b10xxxxxx) is the middle of a character: start at the
		// next one, so the kept text never opens on a replacement character.
		while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) {
			start += 1;
		}
		this.helperOutputText = bytes.subarray(start).toString("utf8");
	}

	/**
	 * Asks the helper to write the trailer and exit, then returns what it made.
	 *
	 * Waits for the PROCESS to exit rather than for `capture-stopped` alone: the
	 * MP4's moov atom is written during teardown, and returning a path to a file
	 * whose index is still being written would hand the app an unplayable
	 * recording.
	 *
	 * A helper that died first, or during the stop, never says `capture-stopped`.
	 * Its file is fragmented MP4, so what it wrote up to its last whole fragment
	 * still opens: that part is returned with `interrupted` set, as macOS and
	 * Windows keep theirs. Only a file with no usable frame is deleted and thrown.
	 */
	async stop(): Promise<LinuxCaptureResult> {
		this.stopRequested = true;
		const child = this.process;
		let failure: unknown = null;
		this.completeCursorPauseRange();
		if (child) {
			const exited = new Promise<void>((resolve, reject) => {
				this.stoppedResolve = resolve;
				this.stoppedReject = reject;
			});
			this.write("stop");
			try {
				child.stdin.end();
			} catch {
				// Already closed if the helper died on its own; the exit handler runs.
			}

			const timer = setTimeout(() => {
				console.error("[capture-linux] helper did not exit in time; terminating");
				this.kill();
			}, STOP_TIMEOUT_MS);
			try {
				await exited;
			} catch (error) {
				failure = error;
			} finally {
				clearTimeout(timer);
			}
		}

		if (this.stopped) {
			return this.stopped;
		}
		// The helper has exited on every path that reaches here, so nothing writes the
		// file any more and cutting off a torn tail is safe.
		return this.recoverInterruptedTake(
			failure ?? new Error(this.exitReason ?? "The Linux capture helper produced no output file."),
		);
	}

	private async recoverInterruptedTake(failure: unknown): Promise<LinuxCaptureResult> {
		const outputPath = this.config.outputPath;
		const salvage = await salvageNativeMacCapture(outputPath);
		if (!salvage.ok) {
			console.error("[capture-linux] nothing recoverable in the interrupted take", {
				failure: String(failure),
				reason: salvage.reason,
			});
			await fs.rm(outputPath, { force: true }).catch(() => undefined);
			throw failure instanceof Error ? failure : new Error(String(failure));
		}
		console.warn("[capture-linux] recovered the part of the take written before the helper died", {
			failure: String(failure),
			path: salvage.screenVideoPath,
			videoSamples: salvage.videoSamples,
			durationSec: salvage.durationSec,
			truncatedBytes: salvage.truncatedBytes,
		});
		this.stopped = {
			path: salvage.screenVideoPath,
			durationMs: Math.round(salvage.durationSec * 1000),
			frames: salvage.videoSamples,
			droppedFrames: 0,
			cursor: this.stoppedCursorData(),
			...(this.sourceKind ? { sourceKind: this.sourceKind } : {}),
			...(this.videoEncoder ? { videoEncoder: this.videoEncoder } : {}),
			...(this.audioLost ? { audioLost: true as const } : {}),
			// A helper that fails while stopping on the user's Stop still keeps its take,
			// but the user stopped it: no "stopped unexpectedly" warning.
			...(this.diedMidTake ? { interrupted: true as const } : {}),
		};
		return this.stopped;
	}

	/** The helper exited mid-take before anyone asked it to stop. */
	get interrupted() {
		return this.diedMidTake;
	}

	/** Kills the helper and discards whatever it wrote. */
	discard() {
		this.stopRequested = true;
		this.kill();
	}

	private write(command: string) {
		try {
			this.process?.stdin.write(`${command}\n`);
		} catch {
			// The helper is gone; stop()/exit already reports that.
		}
	}

	private kill() {
		const child = this.process;
		if (!child || child.killed) {
			return;
		}
		child.kill("SIGTERM");
		setTimeout(() => {
			if (!child.killed) {
				child.kill("SIGKILL");
			}
		}, 500).unref();
	}

	private handleStdout(chunk: string) {
		this.lines.push(chunk, (line) => {
			let payload: PipeWireHelperEvent;
			try {
				payload = JSON.parse(line) as PipeWireHelperEvent;
			} catch (error) {
				this.appendHelperOutput(`${line}\n`);
				console.error("Failed to parse Linux capture helper output:", error, line);
				return;
			}
			if (payload.event !== "cursor-sample") {
				this.appendHelperOutput(`${line}\n`);
			}
			this.handleEvent(payload);
		});
	}

	private handleEvent(payload: PipeWireHelperEvent) {
		switch (payload.event) {
			case "ready":
				if (payload.cursorMode === "metadata" || payload.cursorMode === "embedded") {
					this.negotiatedCursorMode = payload.cursorMode;
				}
				this.resolveReady();
				return;

			case "source-selected":
				if (payload.sourceKind) {
					this.sourceKind = payload.sourceKind;
				}
				this.sourceSelected = true;
				this.sourceSelectedAtMs = Date.now();
				console.info(
					"[capture-linux] source selected",
					JSON.stringify({ sourceKind: payload.sourceKind ?? null }),
				);
				this.sourceSelectedResolve?.();
				this.sourceSelectedResolve = null;
				this.sourceSelectedReject = null;
				this.startFirstFrameTimer();
				return;

			case "stream-started":
				if (payload.sourceKind) {
					this.sourceKind = payload.sourceKind;
				}
				// The source kind is logged unconditionally for the same reason
				// as the audio node: when someone reports "I picked a window and
				// got my whole screen", this line is the answer, and it is the
				// only place the truth appears — the app cannot name a source
				// when asking the portal, so nothing upstream knows it.
				console.info(
					"[capture-linux] portal stream started",
					JSON.stringify({
						width: payload.width,
						height: payload.height,
						sourceKind: payload.sourceKind ?? null,
					}),
				);
				return;

			case "audio-source":
				// Logged unconditionally: when someone reports "that is not my
				// microphone", this line is the answer.
				console.info(
					"[capture-linux] audio source",
					JSON.stringify({
						role: payload.role,
						requested: payload.requested ?? null,
						node: payload.node ?? null,
					}),
				);
				if (payload.requested && !payload.node) {
					console.warn(
						`[capture-linux] no PipeWire node matched ${JSON.stringify(payload.requested)}; ` +
							"the session default source was recorded instead",
					);
				}
				return;

			case "encoder-selection":
				this.videoEncoder = payload.video;
				console.info(
					"[capture-linux] encoder",
					JSON.stringify({ video: payload.video, rejected: payload.rejected ?? [] }),
				);
				return;

			case "capture-started":
				// Cursor samples started flowing when the helper did, which was
				// before the portal picker. The recording's zero is HERE, so the
				// telemetry is re-based onto it and anything from during the
				// picker is dropped rather than left pinned to the start.
				this.cursor.rebase(payload.timestampMs);
				this.cursorRecordingStartMs = payload.timestampMs;
				this.capturing = true;
				console.info(
					"[capture-linux] capture started",
					JSON.stringify({ width: payload.width, height: payload.height, fps: payload.fps }),
				);
				this.startedResolve?.();
				this.startedResolve = null;
				this.startedReject = null;
				return;

			case "cursor-sample":
				this.cursor.addSample(payload);
				return;

			case "capture-stopped":
				this.stopped = {
					path: payload.path,
					durationMs: payload.durationMs,
					frames: payload.frames,
					droppedFrames: payload.dropped,
					cursor: this.stoppedCursorData(payload.timestampMs),
					...(this.sourceKind ? { sourceKind: this.sourceKind } : {}),
					...(this.videoEncoder ? { videoEncoder: this.videoEncoder } : {}),
					...(this.audioLost ? { audioLost: true as const } : {}),
				};
				console.info(
					"[capture-linux] capture stopped",
					JSON.stringify({
						frames: payload.frames,
						dropped: payload.dropped,
						durationMs: payload.durationMs,
						convertMs: payload.convertMs,
						uploadMs: payload.uploadMs,
						encodeMs: payload.encodeMs,
					}),
				);
				return;

			case "warning":
				console.warn(`[capture-linux] ${payload.code}: ${payload.message}`);
				// Only a lost audio track is the user's business. The rest, such as a frame
				// Mutter marks corrupted (most Wayland takes have one), are dropped frames
				// the take survives, and their text is for the log.
				if (payload.code === "audio-unavailable") {
					this.audioLost = true;
				}
				return;

			case "error": {
				console.error(`[capture-linux] ${payload.code}: ${payload.message}`);
				// Kept so the process-exit handler can report the CAUSE rather
				// than just the exit code, which on its own says nothing useful.
				this.lastError = payload.message;
				// The code rides along so a dismissed picker is not read as a failure.
				const error = Object.assign(new Error(payload.message), { code: payload.code });
				this.rejectReady(error);
				if (!this.sourceSelected) this.sourceSelectionError ??= error;
				this.sourceSelectedReject?.(error);
				this.sourceSelectedReject = null;
				this.sourceSelectedResolve = null;
				return;
			}

			case "debug":
				console.info("[capture-linux][debug]", JSON.stringify(payload));
				return;
		}
	}

	private resolveReady() {
		const resolve = this.readyResolve;
		this.clearReadyState();
		resolve?.();
	}

	private rejectReady(error: Error) {
		const reject = this.readyReject;
		this.clearReadyState();
		reject?.(error);
	}

	private clearReadyState() {
		if (this.readyTimer) {
			clearTimeout(this.readyTimer);
			this.readyTimer = null;
		}
		this.readyResolve = null;
		this.readyReject = null;
	}
}
