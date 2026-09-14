import type { ChildProcessWithoutNullStreams } from "node:child_process";

/**
 * Stopping a native macOS (ScreenCaptureKit) recording, as a unit that can be
 * tested — the macOS twin of `nativeWindowsCaptureStop.ts`, which exists for
 * the same reason: `electron/ipc/handlers.ts` cannot be loaded from a test.
 *
 * # Why the stop settles on the helper's exit, not on its first error
 *
 * The helper speaks two kinds of error. `writer-failed-during-capture` and
 * `capture-stopped-with-error` say that the take ended on its own; the helper
 * then shuts down by itself (issue #621, PR #655) and still reports how that
 * went, with `recording-stopped` or `writer-failed`. The stop used to reject on
 * the first `"event":"error"` in the whole buffered output, so a take whose
 * capture stopped but whose file was finalized was thrown away with an error,
 * and a take whose writer died was rejected before the helper had finished
 * writing anything down.
 *
 * The helper always exits once it has received `stop` and finished (its command
 * loop runs `await recorder.stop(); exit(0)`), after its last word. So the one
 * moment at which the output is complete and the file is no longer being
 * written is the process's `close`. That is also where Windows settles.
 */

/** Outer bound on a stop. Unchanged from the wait this replaced. */
export const NATIVE_MAC_CAPTURE_STOP_TIMEOUT_MS = 30_000;

/** How the helper process ended, as Node's `close` reports it. */
export type NativeMacCaptureExit = {
	code: number | null;
	signal: NodeJS.Signals | null;
};

export type NativeMacCaptureStopResult =
	| {
			ok: true;
			screenVideoPath: string;
			/** Why the take ended before the user stopped it, when it did. */
			warning?: string;
	  }
	| {
			ok: false;
			reason: "helper-failed" | "stop-timeout";
			message: string;
			/** False when the helper was still running when the wait gave up. */
			exited: boolean;
	  };

/**
 * Errors after which the helper stops itself and still reports a terminal
 * outcome. They explain a stop; they never settle one.
 */
const INTERRUPTION_ERROR_CODES = new Set([
	"writer-failed-during-capture",
	"capture-stopped-with-error",
]);

type HelperEvent = Record<string, unknown>;

function parseHelperEvent(line: string): HelperEvent | null {
	const candidates = [line];
	// stdout and stderr drain into one buffer chunk by chunk, so a stderr line can
	// end up glued onto the front of a JSON event.
	const braceIndex = line.indexOf("{");
	if (braceIndex > 0) {
		candidates.push(line.slice(braceIndex));
	}
	for (const candidate of candidates) {
		try {
			const parsed = JSON.parse(candidate);
			if (parsed && typeof parsed === "object" && typeof parsed.event === "string") {
				return parsed as HelperEvent;
			}
		} catch {
			// Not an event; the helper log also carries plain text.
		}
	}
	return null;
}

export function readNativeMacHelperEvents(output: string): HelperEvent[] {
	const events: HelperEvent[] = [];
	for (const line of output.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed) {
			continue;
		}
		const event = parseHelperEvent(trimmed);
		if (event) {
			events.push(event);
		}
	}
	return events;
}

/** `Array.prototype.findLast`, which the project's ES library target predates. */
function lastWhere(events: HelperEvent[], matches: (event: HelperEvent) => boolean) {
	for (let index = events.length - 1; index >= 0; index -= 1) {
		if (matches(events[index])) {
			return events[index];
		}
	}
	return undefined;
}

function messageOf(event: HelperEvent) {
	if (typeof event.message === "string" && event.message.trim()) {
		return event.message.trim();
	}
	return typeof event.code === "string" ? event.code : "Native macOS capture failed";
}

function describeExit(exit: NativeMacCaptureExit) {
	if (exit.signal) {
		return `The recorder stopped unexpectedly (signal ${exit.signal}).`;
	}
	if (exit.code === 0) {
		return "The recorder exited without reporting a finished recording.";
	}
	return `The recorder stopped unexpectedly (exit code ${exit.code ?? "unknown"}).`;
}

/**
 * What the helper's output says about a stop, or null while it has not said
 * enough yet. `exit` is null while the helper is still running.
 */
export function readNativeMacStopOutcome(
	output: string,
	exit: NativeMacCaptureExit | null,
	targetPath: string | null,
): NativeMacCaptureStopResult | null {
	const events = readNativeMacHelperEvents(output);
	const isInterruption = (event: HelperEvent) =>
		typeof event.code === "string" && INTERRUPTION_ERROR_CODES.has(event.code);
	const stopped = lastWhere(events, (event) => event.event === "recording-stopped");
	const errors = events.filter((event) => event.event === "error");
	const interruption = errors.find(isInterruption);
	const failure = lastWhere(errors, (event) => !isInterruption(event));
	const exited = exit !== null;

	// A finalized file outranks anything said before it: this is the take the
	// user would otherwise lose.
	if (stopped) {
		const reportedPath =
			typeof stopped.screenPath === "string" && stopped.screenPath ? stopped.screenPath : null;
		const screenVideoPath = reportedPath ?? targetPath;
		if (!screenVideoPath) {
			return {
				ok: false,
				reason: "helper-failed",
				message: "Native macOS capture did not return an output path.",
				exited,
			};
		}
		if (!interruption) {
			return { ok: true, screenVideoPath };
		}
		const reason = messageOf(interruption).replace(/[.\s]+$/, "");
		return {
			ok: true,
			screenVideoPath,
			warning: `Recording ended early (${reason}). The part recorded until then was saved.`,
		};
	}

	if (failure) {
		// The interruption is what the user can act on ("the video file could not be
		// written"); the terminal error that follows it is the raw NSError behind it.
		return {
			ok: false,
			reason: "helper-failed",
			message: messageOf(interruption ?? failure),
			exited,
		};
	}

	if (!exit) {
		return null;
	}

	// A helper that exits 0 without a word finalized the file it was asked for —
	// unless it had already said the take ended, in which case exit 0 only means
	// its command pipe closed.
	if (exit.code === 0 && !exit.signal && targetPath && !interruption) {
		return { ok: true, screenVideoPath: targetPath };
	}
	return {
		ok: false,
		reason: "helper-failed",
		message: interruption ? messageOf(interruption) : describeExit(exit),
		exited: true,
	};
}

/**
 * Waits for the helper to finish a stop and says how it went.
 *
 * Resolves rather than rejects, like the Windows wait: the caller needs to tell
 * a helper failure apart from a timeout, and a discard has to proceed either
 * way.
 */
export function waitForNativeMacCaptureStop(options: {
	proc: ChildProcessWithoutNullStreams;
	/** Path we asked the helper to write, used when it exits 0 without saying so. */
	targetPath: string | null;
	/** The accumulated helper output; read lazily so late chunks are included. */
	readOutput: () => string;
	/**
	 * How the helper exited, once its output drain has seen `close`. Read from the
	 * drain rather than from `proc.exitCode`, because `exit` can fire before the
	 * last output chunk has been read.
	 */
	readExit: () => NativeMacCaptureExit | null;
	timeoutMs?: number;
}): Promise<NativeMacCaptureStopResult> {
	const { proc, targetPath, readOutput, readExit } = options;
	const timeoutMs = options.timeoutMs ?? NATIVE_MAC_CAPTURE_STOP_TIMEOUT_MS;

	const settleFromExit = (exit: NativeMacCaptureExit): NativeMacCaptureStopResult =>
		readNativeMacStopOutcome(readOutput(), exit, targetPath) ?? {
			ok: false,
			reason: "helper-failed",
			message: describeExit(exit),
			exited: true,
		};

	// The helper may already be gone: killed, crashed, or exited after stopping
	// itself. Node never re-emits `close`, so waiting for one would burn the whole
	// timeout on a recorder that has nothing left to say.
	const alreadyExited = readExit();
	if (alreadyExited) {
		return Promise.resolve(settleFromExit(alreadyExited));
	}

	return new Promise<NativeMacCaptureStopResult>((resolve) => {
		const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
			cleanup();
			resolve(settleFromExit(readExit() ?? { code, signal }));
		};
		const onError = (error: Error) => {
			cleanup();
			resolve({
				ok: false,
				reason: "helper-failed",
				message: error.message,
				exited: proc.exitCode !== null || proc.signalCode !== null,
			});
		};
		const cleanup = () => {
			clearTimeout(timer);
			proc.off("close", onClose);
			proc.off("error", onError);
		};

		const timer = setTimeout(() => {
			cleanup();
			// A helper that already reported a finalized file but has not exited still
			// left a complete recording behind. It is not killed here: one that has not
			// reported may be inside a slow finishWriting, and this helper has no
			// shutdown ceiling that would make killing it safe.
			const outcome = readNativeMacStopOutcome(readOutput(), null, targetPath);
			resolve(
				outcome ?? {
					ok: false,
					reason: "stop-timeout",
					message: "The recorder did not finish saving in time.",
					exited: false,
				},
			);
		}, timeoutMs);

		proc.once("close", onClose);
		proc.once("error", onError);
	});
}

/**
 * Sends `stop` to a helper that can still hear it. Returns whether it was sent.
 *
 * A helper that already exited has closed its command pipe, and writing to it
 * raises EPIPE or ERR_STREAM_DESTROYED on `proc.stdin`.
 */
export function sendNativeMacStopCommand(proc: ChildProcessWithoutNullStreams): boolean {
	if (proc.exitCode !== null || proc.signalCode !== null || !proc.stdin.writable) {
		return false;
	}
	proc.stdin.write("stop\n");
	return true;
}
