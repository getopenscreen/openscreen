import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";

/**
 * Apple's system picker on macOS 15.2+, and the long-lived helper that records from it.
 *
 * A capture started from `SCContentSharingPicker` needs no Screen Recording grant and never
 * raises macOS 15's "bypass the system private window picker" alert: the user's pick is
 * the consent. That consent lives in a filter that cannot leave the helper process, so one
 * helper (`--picker-session`) stays up for the whole app session, shows the picker, and
 * records every take from the retained pick. See PickerSession.swift.
 *
 * The rest of the macOS recording code was written against one helper process per take:
 * it reads a take's events from `proc.stdout`, sends `pause`/`resume`/`stop` on
 * `proc.stdin`, and treats `close` as "this take's output is complete". `startTake`
 * therefore hands back a `TakeProcess` with exactly that surface, carrying only this
 * take's lines and "exiting" on the session's `take-ended`, so start, stop, salvage and
 * the mid-capture error watch all run unchanged.
 */

/** The id prefix of a source picked in Apple's picker. It is not a desktopCapturer id. */
export const MAC_PICKER_SOURCE_PREFIX = "mac-picker:";

export function isMacPickerSourceId(id: unknown): boolean {
	return typeof id === "string" && id.startsWith(MAC_PICKER_SOURCE_PREFIX);
}

/**
 * 15.2, not 14.0 where the picker API starts: the filter only reports which display or
 * window was picked, and where, from 15.2 -- and the cursor telemetry needs that.
 */
export function supportsMacSystemPicker(systemVersion: string): boolean {
	const [major = 0, minor = 0] = systemVersion.split(".").map((part) => Number.parseInt(part, 10));
	return major > 15 || (major === 15 && minor >= 2);
}

let systemPickerUnavailable = false;

/**
 * For the rest of this run, sources come from the app's own picker: the session could not
 * start (a helper that predates `--picker-session`, or none at all).
 */
export function markMacSystemPickerUnavailable() {
	systemPickerUnavailable = true;
}

/**
 * Whether this Mac picks sources in Apple's picker. Also true while the helper has not
 * been tried yet; `OPENSCREEN_MAC_SOURCE_PICKER=legacy` forces the app's own picker.
 */
export function macSystemPickerEnabled(): boolean {
	return (
		process.platform === "darwin" &&
		!systemPickerUnavailable &&
		process.env.OPENSCREEN_MAC_SOURCE_PICKER !== "legacy" &&
		supportsMacSystemPicker(process.getSystemVersion())
	);
}

export interface MacPickerSelection {
	kind: "display" | "window";
	displayId: number | null;
	windowId: number | null;
	/** Window title, empty for a display. */
	title: string;
	/** Owning app of a picked window, empty for a display. */
	appName: string;
	/** Global frame, points, top-left origin: what the cursor telemetry normalises against. */
	bounds: { x: number; y: number; width: number; height: number };
}

type HelperEvent = Record<string, unknown> & { event?: unknown };

const READY_TIMEOUT_MS = 5_000;

function parseEvent(line: string): HelperEvent | null {
	try {
		const parsed: unknown = JSON.parse(line);
		return parsed && typeof parsed === "object" ? (parsed as HelperEvent) : null;
	} catch {
		return null;
	}
}

function asNumber(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function parsePickerSelection(event: HelperEvent): MacPickerSelection | null {
	const bounds = event.bounds as Record<string, unknown> | undefined;
	const x = asNumber(bounds?.x);
	const y = asNumber(bounds?.y);
	const width = asNumber(bounds?.width);
	const height = asNumber(bounds?.height);
	if (x === null || y === null || width === null || height === null) {
		return null;
	}
	return {
		kind: event.kind === "window" ? "window" : "display",
		displayId: asNumber(event.displayId),
		windowId: asNumber(event.windowId),
		title: typeof event.title === "string" ? event.title : "",
		appName: typeof event.appName === "string" ? event.appName : "",
		bounds: { x, y, width, height },
	};
}

/**
 * One take, dressed as the per-take helper process the recording code expects.
 * Only the members that code touches exist; the cast at `startTake` says so.
 */
class TakeProcess extends EventEmitter {
	readonly stdout = new PassThrough();
	readonly stderr = new PassThrough();
	readonly stdin: Writable;
	exitCode: number | null = null;
	signalCode: NodeJS.Signals | null = null;
	killed = false;
	private sawError = false;
	private sawStopped = false;

	constructor(private readonly command: (line: string) => boolean) {
		super();
		const take = this;
		this.stdin = new Writable({
			write(chunk, _encoding, callback) {
				// The single-take protocol's bare words (`pause`, `resume`, `stop`) are also
				// the session's, so they pass through as they are.
				for (const line of String(chunk).split(/\r?\n/)) {
					if (line.trim() && !take.ended) {
						take.command(line.trim());
					}
				}
				callback();
			},
		});
	}

	get ended() {
		return this.exitCode !== null || this.signalCode !== null;
	}

	deliver(line: string, event: HelperEvent | null) {
		if (event?.event === "error") {
			this.sawError = true;
		}
		if (event?.event === "recording-stopped") {
			this.sawStopped = true;
		}
		this.stdout.write(`${line}\n`);
	}

	/**
	 * The session's `take-ended`, read as the single-take helper's exit: 0 when the take
	 * finished its file or never failed, 1 when it reported an error and no file.
	 */
	end(signal: NodeJS.Signals | null = null) {
		if (this.ended) {
			return;
		}
		if (signal) {
			this.signalCode = signal;
		} else {
			this.exitCode = this.sawError && !this.sawStopped ? 1 : 0;
		}
		this.stdin.end();
		this.stdout.end();
		this.stderr.end();
		this.emit("exit", this.exitCode, this.signalCode);
		// `close` after the streams have flushed, as for a real child process.
		setImmediate(() => this.emit("close", this.exitCode, this.signalCode));
	}

	/** A take cannot be killed on its own without killing every later one: stop it. */
	kill() {
		this.killed = true;
		if (!this.ended) {
			this.command("stop");
		}
		return true;
	}
}

export class MacPickerSession {
	private proc: ChildProcessWithoutNullStreams | null = null;
	private starting: Promise<boolean> | null = null;
	private selection: MacPickerSelection | null = null;
	private take: TakeProcess | null = null;
	private pendingPick: ((selection: MacPickerSelection | null) => void) | null = null;
	private lineBuffer = "";

	constructor(
		private readonly helperPath: string,
		private readonly spawnHelper: typeof spawn = spawn,
	) {}

	getSelection(): MacPickerSelection | null {
		return this.selection;
	}

	/** Starts the helper if it is not running. Resolves false when it cannot. */
	start(): Promise<boolean> {
		if (this.proc) {
			return Promise.resolve(true);
		}
		this.starting ??= new Promise<boolean>((resolve) => {
			let proc: ChildProcessWithoutNullStreams;
			try {
				proc = this.spawnHelper(this.helperPath, ["--picker-session"], {
					stdio: ["pipe", "pipe", "pipe"],
				}) as ChildProcessWithoutNullStreams;
			} catch (error) {
				console.warn("[mac-picker] could not start the picker session:", error);
				this.starting = null;
				resolve(false);
				return;
			}

			const timer = setTimeout(() => {
				console.warn("[mac-picker] the picker session never reported ready");
				proc.kill();
				settle(false);
			}, READY_TIMEOUT_MS);
			const settle = (ok: boolean) => {
				clearTimeout(timer);
				this.starting = null;
				resolve(ok);
			};

			proc.stdout.on("data", (chunk: Buffer) => {
				this.lineBuffer += chunk.toString();
				const lines = this.lineBuffer.split(/\r?\n/);
				this.lineBuffer = lines.pop() ?? "";
				for (const line of lines) {
					if (!line.trim()) {
						continue;
					}
					const event = parseEvent(line);
					if (event?.event === "picker-session-ready") {
						this.proc = proc;
						settle(true);
						continue;
					}
					this.route(line, event);
				}
			});
			proc.stderr.on("data", (chunk: Buffer) => {
				const text = chunk.toString();
				if (this.take) {
					this.take.stderr.write(text);
				} else {
					console.warn(`[mac-picker] ${text.trim()}`);
				}
			});
			proc.stdin.on("error", (error) => console.warn("[mac-picker] command pipe error:", error));
			proc.on("error", (error) => {
				console.warn("[mac-picker] helper error:", error);
				settle(false);
			});
			proc.once("close", (_code, signal) => {
				this.onSessionGone(signal ?? "SIGTERM");
				settle(false);
			});
		});
		return this.starting;
	}

	/**
	 * Shows Apple's picker. Resolves with what the user picked, or null when they cancelled
	 * or the picker could not open. No timeout: a person is choosing.
	 */
	async present(
		excludedWindowIds: number[],
		hideDesktopIcons = false,
	): Promise<MacPickerSelection | null> {
		if (!(await this.start())) {
			return null;
		}
		// A second click while the picker is up re-presents it; the first caller gets the
		// same answer as the second.
		const previous = this.pendingPick;
		const answer = new Promise<MacPickerSelection | null>((resolve) => {
			this.pendingPick = (selection) => {
				previous?.(selection);
				resolve(selection);
			};
		});
		this.send({
			command: "present",
			excludedWindowIds,
			modes: ["display", "window"],
			hideDesktopIcons,
		});
		return answer;
	}

	/**
	 * Starts a take from the retained pick. The returned object stands in for the per-take
	 * helper process; see the module comment.
	 */
	startTake(request: unknown): ChildProcessWithoutNullStreams {
		if (!this.proc || !this.selection) {
			throw new Error("Pick a screen or window in the system picker first.");
		}
		if (this.take && !this.take.ended) {
			throw new Error("A recording is already running in the picker session.");
		}
		const take = new TakeProcess((line) => this.send(line));
		this.take = take;
		this.send({ command: "start", request });
		return take as unknown as ChildProcessWithoutNullStreams;
	}

	/** Ends the session with the app. Closing stdin makes the helper stop and exit. */
	dispose() {
		this.proc?.stdin.end();
		this.proc = null;
	}

	private send(command: string | Record<string, unknown>): boolean {
		const proc = this.proc;
		if (!proc || !proc.stdin.writable) {
			return false;
		}
		proc.stdin.write(`${typeof command === "string" ? command : JSON.stringify(command)}\n`);
		return true;
	}

	private route(line: string, event: HelperEvent | null) {
		switch (event?.event) {
			case "picker-presented":
				return;
			case "picker-selected": {
				const selection = parsePickerSelection(event);
				if (selection) {
					this.selection = selection;
				}
				this.resolvePick(selection);
				return;
			}
			case "picker-cancelled":
			case "picker-failed":
				if (event.event === "picker-failed") {
					console.warn("[mac-picker] the picker failed:", event.message);
				}
				this.resolvePick(null);
				return;
			case "take-ended":
				this.take?.end();
				this.take = null;
				return;
		}
		if (this.take) {
			this.take.deliver(line, event);
		} else if (event?.event === "error" || event?.event === "warning") {
			console.warn("[mac-picker] session:", line);
		}
	}

	private resolvePick(selection: MacPickerSelection | null) {
		const pending = this.pendingPick;
		this.pendingPick = null;
		pending?.(selection);
	}

	private onSessionGone(signal: NodeJS.Signals) {
		this.proc = null;
		this.lineBuffer = "";
		// The pick lived in that process; it is gone with it.
		this.selection = null;
		this.take?.end(signal);
		this.take = null;
		this.resolvePick(null);
	}
}
