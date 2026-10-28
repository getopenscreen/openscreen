import { type ChildProcess, execFile, type SpawnOptions, spawn } from "node:child_process";
import { promisify } from "node:util";
import { type Rectangle, screen } from "electron";
import type { CursorRecordingData, CursorRecordingSample } from "../../../../src/native/contracts";
import { clamp } from "../../../../src/utils/math";
import type { CursorRecordingSession } from "./session";
import {
	consumeXevButtonEvents,
	consumeXInputXi2Events,
	interactionTypeForButton,
	parseLibinputButtonLine,
	parseXdotoolLocation,
} from "./x11PointerParse";

const execFileAsync = promisify(execFile);

export interface X11PointerRecordingSessionOptions {
	getDisplayBounds: () => Rectangle | null;
	maxSamples: number;
	sampleIntervalMs: number;
	startTimeMs?: number;
	/** Test injection: current pointer in screen pixels. */
	getPoint?: () => { x: number; y: number } | null;
	/** Test injection: subscribe to left/middle/right button edges. */
	watchButtons?: (handlers: {
		onPress: (button: number) => void;
		onRelease: (button: number) => void;
	}) => () => void;
}

type SpawnFn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

const CLICK_WATCHERS: { command: string; args: string[]; kind: "xi2" | "xev" | "libinput" }[] = [
	{ command: "xinput", args: ["test-xi2", "--root"], kind: "xi2" },
	{ command: "xev", args: ["-root", "-event", "button"], kind: "xev" },
	{ command: "libinput", args: ["debug-events"], kind: "libinput" },
];

/**
 * Position + click sampler for Linux X11 (including Xvfb) when the ScreenCast
 * portal has no METADATA cursor mode.
 *
 * Position comes from Electron's `screen.getCursorScreenPoint()` (correct on
 * X11), falling back to `xdotool getmouselocation` if the Electron point sits
 * at the origin while xdotool disagrees. Clicks come from the first tool that
 * actually starts: `xinput test-xi2 --root`, then `xev -root -event button`,
 * then `libinput debug-events`.
 */
export class X11PointerRecordingSession implements CursorRecordingSession {
	private samples: CursorRecordingSample[] = [];
	private interval: NodeJS.Timeout | null = null;
	private startTimeMs = 0;
	private stopClickWatcher: (() => void) | null = null;
	private lastPoint: { x: number; y: number } | null = null;

	constructor(
		private readonly options: X11PointerRecordingSessionOptions,
		private readonly spawnFn: SpawnFn = spawn,
	) {}

	async start(): Promise<void> {
		this.samples = [];
		this.startTimeMs = this.options.startTimeMs ?? Date.now();
		this.captureSample("move");
		this.interval = setInterval(() => {
			this.captureSample("move");
		}, this.options.sampleIntervalMs);
		this.stopClickWatcher = this.options.watchButtons
			? this.options.watchButtons({
					onPress: (button) => this.recordButton("press", button),
					onRelease: (button) => this.recordButton("release", button),
				})
			: this.startExternalClickWatcher();
	}

	async stop(): Promise<CursorRecordingData> {
		if (this.interval) {
			clearInterval(this.interval);
			this.interval = null;
		}
		this.stopClickWatcher?.();
		this.stopClickWatcher = null;

		return {
			version: 2,
			provider: "none",
			samples: this.samples,
			assets: [],
		};
	}

	updateCaptureBounds(_bounds: Rectangle): void {
		// Positions are re-read against getDisplayBounds() on every sample.
	}

	private recordButton(kind: "press" | "release", button: number) {
		const interactionType = interactionTypeForButton(kind, button);
		if (!interactionType) {
			return;
		}
		this.captureSample(interactionType);
	}

	private captureSample(interactionType: CursorRecordingSample["interactionType"]) {
		const point = this.readPoint() ?? this.lastPoint;
		if (!point) {
			return;
		}
		this.lastPoint = point;
		const display = this.options.getDisplayBounds() ?? screen.getDisplayNearestPoint(point).bounds;
		const width = Math.max(1, display.width);
		const height = Math.max(1, display.height);
		this.samples.push({
			timeMs: Math.max(0, Date.now() - this.startTimeMs),
			cx: clamp((point.x - display.x) / width, 0, 1),
			cy: clamp((point.y - display.y) / height, 0, 1),
			visible: true,
			interactionType: interactionType ?? "move",
		});
		if (this.samples.length > this.options.maxSamples) {
			this.samples.shift();
		}
	}

	private readPoint(): { x: number; y: number } | null {
		if (this.options.getPoint) {
			return this.options.getPoint();
		}
		const cursor = screen.getCursorScreenPoint();
		if (cursor.x !== 0 || cursor.y !== 0) {
			return cursor;
		}
		// {0,0} is either the real origin or a Wayland-style lie. Prefer xdotool
		// when it answers with a different point; otherwise keep the Electron value.
		refreshXdotoolLocationCache();
		return xdotoolCache ?? cursor;
	}

	private startExternalClickWatcher(): () => void {
		let child: ChildProcess | null = null;
		let cancelled = false;
		let buffer = "";
		let kind: (typeof CLICK_WATCHERS)[number]["kind"] | null = null;

		const handleChunk = (chunk: string) => {
			buffer += chunk;
			if (kind === "xi2") {
				const parsed = consumeXInputXi2Events(buffer);
				buffer = parsed.rest;
				for (const event of parsed.events) {
					this.recordButton(event.kind, event.button);
				}
				return;
			}
			if (kind === "xev") {
				const parsed = consumeXevButtonEvents(buffer);
				buffer = parsed.rest;
				for (const event of parsed.events) {
					this.recordButton(event.kind, event.button);
				}
				return;
			}
			const lines = buffer.split(/\r?\n/);
			buffer = lines.pop() ?? "";
			for (const line of lines) {
				const event = parseLibinputButtonLine(line);
				if (event) {
					this.recordButton(event.kind, event.button);
				}
			}
		};

		const tryNext = (index: number) => {
			if (cancelled || index >= CLICK_WATCHERS.length) {
				if (!cancelled && index >= CLICK_WATCHERS.length) {
					console.warn(
						"[cursor-x11] no click watcher started (xinput, xev, and libinput all unavailable); " +
							"pointer motion is still recorded",
					);
				}
				return;
			}
			const spec = CLICK_WATCHERS[index];
			let spawned: ChildProcess;
			try {
				spawned = this.spawnFn(spec.command, spec.args, {
					stdio: ["ignore", "pipe", "pipe"],
				});
			} catch (error) {
				console.warn(`[cursor-x11] ${spec.command} could not start:`, error);
				tryNext(index + 1);
				return;
			}
			child = spawned;
			kind = spec.kind;
			let failed = false;
			spawned.once("error", (error) => {
				if (cancelled || failed) {
					return;
				}
				failed = true;
				console.warn(`[cursor-x11] ${spec.command} could not start:`, error);
				tryNext(index + 1);
			});
			spawned.stdout?.setEncoding("utf8");
			spawned.stdout?.on("data", (chunk: string) => handleChunk(chunk));
			spawned.stderr?.resume();
		};

		tryNext(0);

		return () => {
			cancelled = true;
			if (child && !child.killed) {
				child.kill("SIGTERM");
			}
			child = null;
		};
	}
}

let xdotoolCache: { x: number; y: number } | null = null;
let xdotoolInflight = false;

export function refreshXdotoolLocationCache(): void {
	if (xdotoolInflight) {
		return;
	}
	xdotoolInflight = true;
	void execFileAsync("xdotool", ["getmouselocation", "--shell"], {
		timeout: 400,
	})
		.then(({ stdout }) => {
			xdotoolCache = parseXdotoolLocation(stdout);
		})
		.catch(() => {
			xdotoolCache = null;
		})
		.finally(() => {
			xdotoolInflight = false;
		});
}

/** Test hook: reset the process-wide xdotool cache. */
export function resetXdotoolLocationCacheForTests(): void {
	xdotoolCache = null;
	xdotoolInflight = false;
}
