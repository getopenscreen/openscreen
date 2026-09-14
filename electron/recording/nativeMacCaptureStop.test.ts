import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type NativeMacCaptureExit,
	nativeMacDiscardTargets,
	readNativeMacHelperEvents,
	readNativeMacStopOutcome,
	sendNativeMacStopCommand,
	waitForNativeMacCaptureStop,
} from "./nativeMacCaptureStop";

const TARGET = "/rec/recording-1.mp4";

/** What the helper prints, one JSON event per line. */
function line(event: Record<string, unknown>) {
	return `${JSON.stringify(event)}\n`;
}

// The messages as the Swift helper really prints them: the interruption embeds the
// writer's NSError, and a stream the system stopped reports its NSError alone.
const WRITER_DIED_MESSAGE =
	'Recording stopped: the video file could not be written (video append: Error Domain=AVFoundationErrorDomain Code=-11800 "The operation could not be completed" UserInfo={NSLocalizedFailureReason=An unknown error occurred (-16364)}).';
const CAPTURE_STOPPED_MESSAGE =
	'Error Domain=com.apple.ScreenCaptureKit.SCStreamErrorDomain Code=-3815 "The stream was stopped by the system." UserInfo={NSLocalizedDescription=The stream was stopped by the system.}';

const started = line({ event: "recording-started", width: 3840, height: 2160 });
const stopped = line({ event: "recording-stopped", screenPath: TARGET });
const writerDied = line({
	event: "error",
	code: "writer-failed-during-capture",
	message: WRITER_DIED_MESSAGE,
});
const writerFailed = line({
	event: "error",
	code: "writer-failed",
	message: "Error Domain=AVFoundationErrorDomain Code=-11800",
});
const captureStopped = line({
	event: "error",
	code: "capture-stopped-with-error",
	message: CAPTURE_STOPPED_MESSAGE,
});

/**
 * Stands in for openscreen-screencapturekit-helper. `exitCode`/`signalCode` are
 * real `ChildProcess` properties the code under test reads, and `exit()` records
 * the exit the way the output drain in handlers.ts does before `close` reaches
 * any later listener.
 */
class FakeHelper extends EventEmitter {
	stdout = new PassThrough();
	stderr = new PassThrough();
	stdin: Writable;
	written: string[] = [];
	exitCode: number | null = null;
	signalCode: NodeJS.Signals | null = null;
	recordedExit: NativeMacCaptureExit | null = null;

	constructor() {
		super();
		const written = this.written;
		this.stdin = new Writable({
			write(chunk, _encoding, callback) {
				written.push(chunk.toString());
				callback();
			},
		});
	}

	exit(code: number | null, signal: NodeJS.Signals | null = null) {
		this.exitCode = code;
		this.signalCode = signal;
		this.recordedExit = { code, signal };
		this.emit("close", code, signal);
	}
}

function asProc(helper: FakeHelper) {
	return helper as unknown as ChildProcessWithoutNullStreams;
}

let helper: FakeHelper;

beforeEach(() => {
	vi.useFakeTimers();
	helper = new FakeHelper();
});

afterEach(() => {
	vi.useRealTimers();
});

function waitForStop(readOutput: () => string, timeoutMs?: number) {
	return waitForNativeMacCaptureStop({
		proc: asProc(helper),
		targetPath: TARGET,
		readOutput,
		readExit: () => helper.recordedExit,
		timeoutMs,
	});
}

describe("readNativeMacHelperEvents", () => {
	it("reads an event glued behind stderr text", () => {
		const events = readNativeMacHelperEvents(`2026-09-14 helper log line${stopped}`);
		expect(events).toEqual([{ event: "recording-stopped", screenPath: TARGET }]);
	});

	it("skips plain text and objects that are not events", () => {
		expect(readNativeMacHelperEvents('warming up\n{"not":"an event"}\n{broken\n')).toEqual([]);
	});
});

describe("readNativeMacStopOutcome", () => {
	it("takes the path the helper reported", () => {
		expect(readNativeMacStopOutcome(started + stopped, null, "/elsewhere.mp4")).toEqual({
			ok: true,
			screenVideoPath: TARGET,
		});
	});

	it("falls back to the requested path when the report names none", () => {
		expect(
			readNativeMacStopOutcome(
				line({ event: "recording-stopped" }),
				{ code: 0, signal: null },
				TARGET,
			),
		).toEqual({ ok: true, screenVideoPath: TARGET });
	});

	/**
	 * The shape that used to lose a finalized take: capture stopped on its own, the
	 * helper finished the file anyway, and the stop rejected on the earlier error.
	 */
	it("keeps a take whose capture stopped on its own but whose file was finalized", () => {
		expect(readNativeMacStopOutcome(started + captureStopped + stopped, null, TARGET)).toEqual({
			ok: true,
			screenVideoPath: TARGET,
			warning: `Recording ended early (${CAPTURE_STOPPED_MESSAGE}). The part recorded until then was saved.`,
		});
	});

	it("says why the take ended rather than quoting the raw writer error", () => {
		expect(readNativeMacStopOutcome(started + writerDied + writerFailed, null, TARGET)).toEqual({
			ok: false,
			reason: "helper-failed",
			message: WRITER_DIED_MESSAGE,
			exited: false,
		});
	});

	/** The replay that used to reject a stop before the helper had even been told to stop. */
	it("does not settle on an interruption alone while the helper is still running", () => {
		expect(readNativeMacStopOutcome(started + writerDied, null, TARGET)).toBeNull();
	});

	it("keeps the old behaviour for a helper that exits 0 without a word", () => {
		expect(readNativeMacStopOutcome(started, { code: 0, signal: null }, TARGET)).toEqual({
			ok: true,
			screenVideoPath: TARGET,
		});
	});

	/** Exit 0 after an interruption only means the command pipe closed; nothing was finalized. */
	it("does not call exit 0 after an interruption a finished recording", () => {
		expect(
			readNativeMacStopOutcome(started + writerDied, { code: 0, signal: null }, TARGET),
		).toEqual({
			ok: false,
			reason: "helper-failed",
			message: WRITER_DIED_MESSAGE,
			exited: true,
		});
	});

	it("reports a killed helper by its signal instead of dumping its log", () => {
		expect(readNativeMacStopOutcome(started, { code: null, signal: "SIGKILL" }, TARGET)).toEqual({
			ok: false,
			reason: "helper-failed",
			message: "The recorder stopped unexpectedly (signal SIGKILL).",
			exited: true,
		});
	});

	it("refuses a finalized report with no path to point at", () => {
		expect(
			readNativeMacStopOutcome(
				line({ event: "recording-stopped" }),
				{ code: 0, signal: null },
				null,
			),
		).toMatchObject({ ok: false, reason: "helper-failed" });
	});
});

describe("waitForNativeMacCaptureStop", () => {
	it("waits for the helper to exit even when an error is already buffered", async () => {
		let output = started + writerDied;
		let settled = false;
		const pending = waitForStop(() => output).then((result) => {
			settled = true;
			return result;
		});

		await vi.advanceTimersByTimeAsync(1_000);
		expect(settled).toBe(false);

		output += writerFailed;
		helper.exit(0);

		await expect(pending).resolves.toMatchObject({
			ok: false,
			message: WRITER_DIED_MESSAGE,
			exited: true,
		});
	});

	it("resolves with the finalized path once the helper exits", async () => {
		let output = started;
		const pending = waitForStop(() => output);

		output += stopped;
		helper.exit(0);

		await expect(pending).resolves.toEqual({ ok: true, screenVideoPath: TARGET });
	});

	/** Node never re-emits `close`, so a dead helper must not cost the whole timeout. */
	it("settles immediately when the helper has already exited", async () => {
		helper.exit(null, "SIGKILL");

		const result = await waitForStop(() => started);

		expect(result).toEqual({
			ok: false,
			reason: "helper-failed",
			message: "The recorder stopped unexpectedly (signal SIGKILL).",
			exited: true,
		});
		expect(vi.getTimerCount()).toBe(0);
	});

	it("keeps a finalized recording when the helper never exits", async () => {
		const pending = waitForStop(() => started + stopped, 30_000);

		await vi.advanceTimersByTimeAsync(30_000);

		await expect(pending).resolves.toEqual({ ok: true, screenVideoPath: TARGET });
	});

	it("reports a timeout, without claiming the helper exited, when it never finishes", async () => {
		const pending = waitForStop(() => started, 30_000);

		await vi.advanceTimersByTimeAsync(30_000);

		await expect(pending).resolves.toEqual({
			ok: false,
			reason: "stop-timeout",
			message: "The recorder did not finish saving in time.",
			exited: false,
		});
	});

	it("reports a process error as a helper failure", async () => {
		const pending = waitForStop(() => started);

		helper.emit("error", new Error("spawn EACCES"));

		await expect(pending).resolves.toEqual({
			ok: false,
			reason: "helper-failed",
			message: "spawn EACCES",
			exited: false,
		});
	});
});

describe("sendNativeMacStopCommand", () => {
	it("tells a running helper to stop", () => {
		expect(sendNativeMacStopCommand(asProc(helper))).toBe(true);
		expect(helper.written).toEqual(["stop\n"]);
	});

	it("does not write to a helper that already exited", () => {
		helper.exit(null, "SIGKILL");
		expect(sendNativeMacStopCommand(asProc(helper))).toBe(false);
		expect(helper.written).toEqual([]);
	});

	it("does not write to a command pipe that is already closed", () => {
		helper.stdin.destroy();
		expect(sendNativeMacStopCommand(asProc(helper))).toBe(false);
	});
});

describe("nativeMacDiscardTargets", () => {
	it("removes the file the helper finalized", () => {
		expect(nativeMacDiscardTargets({ ok: true, screenVideoPath: "/rec/a.mp4" }, TARGET)).toEqual([
			"/rec/a.mp4",
			"/rec/a.mp4.cursor.json",
		]);
	});

	/** The orphan: a take thrown away after its writer died. */
	it("removes the requested file when the stop failed", () => {
		expect(
			nativeMacDiscardTargets(
				{ ok: false, reason: "helper-failed", message: WRITER_DIED_MESSAGE, exited: true },
				TARGET,
			),
		).toEqual([TARGET, `${TARGET}.cursor.json`]);
	});

	it("removes the requested file when the stop timed out", () => {
		expect(
			nativeMacDiscardTargets(
				{ ok: false, reason: "stop-timeout", message: "timed out", exited: false },
				TARGET,
			),
		).toEqual([TARGET, `${TARGET}.cursor.json`]);
	});

	it("has nothing to remove when no file was ever requested", () => {
		expect(
			nativeMacDiscardTargets(
				{ ok: false, reason: "helper-failed", message: "x", exited: true },
				null,
			),
		).toEqual([]);
	});
});
