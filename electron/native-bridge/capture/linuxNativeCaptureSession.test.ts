import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Same hoisting caveat as the cursor-session test next door: `vi.mock` factories
 * run above every top-level statement, so the cast is written out inline rather
 * than shared through a helper that would still be in its temporal dead zone.
 */
type WithDefault = { default?: Record<string, unknown> };

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	const spawn = vi.fn();
	return { ...actual, spawn, default: { ...((actual as WithDefault).default ?? {}), spawn } };
});

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	// No helper binary in a test checkout; pretend the first candidate resolves so
	// path lookup is not what is under test.
	return {
		...actual,
		accessSync: vi.fn(),
		default: { ...((actual as WithDefault).default ?? {}), accessSync: vi.fn() },
	};
});

import { spawn } from "node:child_process";
import { LinuxNativeCaptureSession } from "./linuxNativeCaptureSession";

class FakeHelper extends EventEmitter {
	stdout = new PassThrough();
	stderr = new PassThrough();
	stdinWrites: string[] = [];
	killed = false;
	stdin: Writable;

	constructor() {
		super();
		const writes = this.stdinWrites;
		this.stdin = new Writable({
			write(chunk, _encoding, callback) {
				writes.push(chunk.toString());
				callback();
			},
		});
	}

	kill() {
		this.killed = true;
		return true;
	}

	emitEvent(event: Record<string, unknown>) {
		this.stdout.write(`${JSON.stringify({ schemaVersion: 1, ...event })}\n`);
	}
}

const spawnMock = vi.mocked(spawn);
let helper: FakeHelper;

function newSession(deferStart = false) {
	return new LinuxNativeCaptureSession({
		...(deferStart ? { deferStart: true } : {}),
		outputPath: "/tmp/recording.mp4",
		cursorMode: "metadata",
		fps: 30,
		audio: {
			system: { enabled: false },
			microphone: { enabled: false, gain: 1 },
		},
		maxCursorSamples: 100,
	});
}

async function startReady(session: LinuxNativeCaptureSession) {
	const started = session.start();
	await Promise.resolve();
	helper.emitEvent({ event: "ready", timestampMs: 1_000 });
	await started;
}

function flushStdout() {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

function emitCaptureStarted(timestampMs: number) {
	helper.emitEvent({
		event: "capture-started",
		timestampMs,
		path: "/tmp/recording.mp4",
		width: 800,
		height: 600,
		fps: 30,
	});
}

function emitCursorSample(timestampMs: number) {
	helper.emitEvent({
		event: "cursor-sample",
		timestampMs,
		x: 400,
		y: 300,
		width: 800,
		height: 600,
		visible: true,
	});
}

async function finishCapture(session: LinuxNativeCaptureSession, timestampMs: number) {
	const stopping = session.stop();
	await flushStdout();
	helper.emitEvent({
		event: "capture-stopped",
		timestampMs,
		path: "/tmp/recording.mp4",
		durationMs: timestampMs - 1_000,
		frames: 27,
		dropped: 0,
	});
	await flushStdout();
	helper.emit("exit", 0, null);
	return stopping;
}

/** Drives a session to a finished recording, optionally granting a source kind. */
async function record(sourceKind?: string) {
	const session = newSession();
	await startReady(session);

	helper.emitEvent({
		event: "stream-started",
		timestampMs: 1_100,
		nodeId: 42,
		width: 1280,
		height: 720,
		...(sourceKind ? { sourceKind } : {}),
	});
	await flushStdout();

	const stopping = session.stop();
	await flushStdout();
	helper.emitEvent({
		event: "capture-stopped",
		timestampMs: 2_000,
		path: "/tmp/recording.mp4",
		durationMs: 900,
		frames: 27,
		dropped: 0,
	});
	await flushStdout();
	helper.emit("exit", 0, null);

	return { session, result: await stopping };
}

beforeEach(() => {
	helper = new FakeHelper();
	spawnMock.mockReset();
	spawnMock.mockReturnValue(helper as unknown as ReturnType<typeof spawn>);
	const silence = () => {
		// The session logs every helper diagnostic; keep the test output readable.
	};
	vi.spyOn(console, "info").mockImplementation(silence);
	vi.spyOn(console, "warn").mockImplementation(silence);
	vi.spyOn(console, "error").mockImplementation(silence);
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("LinuxNativeCaptureSession", () => {
	/**
	 * The regression this file exists for. A restore token is bound to the source
	 * it was minted for, so replaying one made the portal hand back an
	 * already-approved MONITOR on every later run and stop raising its picker —
	 * and since `SelectSources` cannot name a source, "record this window" then
	 * had no way to mean anything. The request must carry no token at all.
	 */
	it("sends no restore token to the helper", async () => {
		await startReady(newSession());

		const [, args] = spawnMock.mock.calls[0];
		const request = JSON.parse((args as string[])[0]) as Record<string, unknown>;

		expect(request).not.toHaveProperty("restoreToken");
		expect(JSON.stringify(request)).not.toContain("restoreToken");
	});

	it("reports the source kind the portal granted", async () => {
		const { session, result } = await record("window");

		expect(session.grantedSourceKind).toBe("window");
		expect(result.sourceKind).toBe("window");
	});

	it("distinguishes a granted monitor from a granted window", async () => {
		const { session, result } = await record("monitor");

		expect(session.grantedSourceKind).toBe("monitor");
		expect(result.sourceKind).toBe("monitor");
	});

	/**
	 * Absent is not "monitor". A backend that omits the field leaves the kind
	 * unknown, and collapsing that into a default is how the UI came to assert a
	 * source the capture had never been told about.
	 */
	it("leaves the granted kind unknown when the portal does not report one", async () => {
		const { session, result } = await record();

		expect(session.grantedSourceKind).toBeUndefined();
		expect(result.sourceKind).toBeUndefined();
	});

	/**
	 * The sequencing fix. The picker has to be answered BEFORE the countdown, so
	 * "a source was chosen" must be observable separately from "pixels are
	 * flowing" — otherwise the only thing to wait on is the first frame, which is
	 * far too late to start counting down.
	 */
	it("resolves the source selection before any frame is captured", async () => {
		const session = newSession(true);
		await startReady(session);

		let selected = false;
		const selecting = session.waitUntilSourceSelected().then(() => {
			selected = true;
		});
		await flushStdout();
		expect(selected).toBe(false);

		helper.emitEvent({
			event: "source-selected",
			timestampMs: 1_100,
			nodeId: 42,
			sourceKind: "window",
		});
		await selecting;

		expect(selected).toBe(true);
		// The kind is known one phase earlier than before, which is when the tray
		// label is needed.
		expect(session.grantedSourceKind).toBe("window");
	});

	it("asks the helper to defer, and arms it only when told to", async () => {
		const session = newSession(true);
		await startReady(session);

		const [, args] = spawnMock.mock.calls[0];
		expect(JSON.parse((args as string[])[0])).toMatchObject({ deferStart: true });
		expect(helper.stdinWrites).not.toContain("record\n");

		session.arm();
		expect(helper.stdinWrites).toContain("record\n");
	});

	it("arms at most once, so a caller need not track whether it prepared", async () => {
		const session = newSession(true);
		await startReady(session);

		session.arm();
		session.arm();
		session.arm();

		expect(helper.stdinWrites.filter((line) => line === "record\n")).toHaveLength(1);
	});

	it("does not ask the helper to defer unless it was configured to", async () => {
		await startReady(newSession());

		const [, args] = spawnMock.mock.calls[0];
		expect(JSON.parse((args as string[])[0])).not.toHaveProperty("deferStart");
	});

	/**
	 * A prepared session is held open across the countdown, so it can die before
	 * it is ever armed — the user revoking the share from the compositor's
	 * indicator, or closing the window they picked. Whoever is waiting on the
	 * picker must learn that instead of waiting forever.
	 */
	it("rejects a pending source selection when the helper dies", async () => {
		const session = newSession(true);
		await startReady(session);

		const selecting = session.waitUntilSourceSelected();
		await flushStdout();
		helper.emit("exit", 1, null);

		await expect(selecting).rejects.toThrow();
	});

	it("resolves the source selection immediately once it has already arrived", async () => {
		const session = newSession(true);
		await startReady(session);

		helper.emitEvent({
			event: "source-selected",
			timestampMs: 1_100,
			nodeId: 42,
			sourceKind: "monitor",
		});
		await flushStdout();

		// Callers must not have to race the event to observe it.
		await expect(session.waitUntilSourceSelected()).resolves.toBeUndefined();
	});

	it("knows the granted kind by the time the capture is confirmed running", async () => {
		const session = newSession();
		await startReady(session);

		const capturing = session.waitUntilCapturing();
		helper.emitEvent({
			event: "stream-started",
			timestampMs: 1_100,
			nodeId: 7,
			width: 800,
			height: 600,
			sourceKind: "window",
		});
		helper.emitEvent({
			event: "capture-started",
			timestampMs: 1_200,
			path: "/tmp/recording.mp4",
			width: 800,
			height: 600,
			fps: 30,
		});
		await capturing;

		expect(session.grantedSourceKind).toBe("window");
	});

	/**
	 * A capture-started event received before the wait is registered must
	 * satisfy that wait: the helper emits it as soon as the first frame stages,
	 * which can be before the caller awaits.
	 */
	it("resolves the capture wait immediately once the first frame already landed", async () => {
		const session = newSession(true);
		await startReady(session);

		session.arm();
		helper.emitEvent({
			event: "capture-started",
			timestampMs: 1_200,
			path: "/tmp/recording.mp4",
			width: 800,
			height: 600,
			fps: 30,
		});
		await flushStdout();

		// Callers must not have to race the event to observe it.
		await expect(session.waitUntilCapturing()).resolves.toBeUndefined();
	});

	/**
	 * Both events in one stdout chunk are handed to the session within one
	 * `data` callback, so no caller can register a wait between them.
	 */
	it("resolves the capture wait when arming and the first frame share a stdout chunk", async () => {
		const session = newSession(true);
		await startReady(session);

		session.arm();
		helper.stdout.write(
			`${JSON.stringify({
				schemaVersion: 1,
				event: "source-selected",
				timestampMs: 1_100,
				nodeId: 42,
				sourceKind: "window",
			})}\n${JSON.stringify({
				schemaVersion: 1,
				event: "capture-started",
				timestampMs: 1_200,
				path: "/tmp/recording.mp4",
				width: 800,
				height: 600,
				fps: 30,
			})}\n`,
		);
		await flushStdout();

		await expect(session.waitUntilCapturing()).resolves.toBeUndefined();
	});

	/**
	 * A helper that died before any frame has nothing to report; the wait
	 * rejects.
	 */
	it("still rejects the capture wait when the helper died before any frame", async () => {
		const session = newSession(true);
		await startReady(session);

		session.arm();
		helper.emit("exit", 1, null);
		await flushStdout();

		await expect(session.waitUntilCapturing()).rejects.toThrow();
	});

	/**
	 * A capture-started event received before the helper died must not answer
	 * a later wait: the recording is no longer running.
	 */
	it("rejects the capture wait when the helper died after its first frame", async () => {
		const session = newSession(true);
		await startReady(session);

		session.arm();
		helper.emitEvent({
			event: "capture-started",
			timestampMs: 1_200,
			path: "/tmp/recording.mp4",
			width: 800,
			height: 600,
			fps: 30,
		});
		await flushStdout();
		helper.emit("exit", 1, null);
		await flushStdout();

		await expect(session.waitUntilCapturing()).rejects.toThrow();
	});

	/**
	 * An undeferred session connects immediately, so the first frame can land
	 * before the caller awaits; the same wait must still be satisfied.
	 */
	it("resolves the capture wait on an undeferred session whose first frame already landed", async () => {
		const session = newSession();
		await startReady(session);

		helper.emitEvent({
			event: "capture-started",
			timestampMs: 1_200,
			path: "/tmp/recording.mp4",
			width: 800,
			height: 600,
			fps: 30,
		});
		await flushStdout();

		await expect(session.waitUntilCapturing()).resolves.toBeUndefined();
	});

	/**
	 * A running capture answers every wait, not only the first one registered
	 * before the event.
	 */
	it("resolves a second capture wait after the first was answered by the event", async () => {
		const session = newSession(true);
		await startReady(session);

		session.arm();
		const first = session.waitUntilCapturing();
		helper.emitEvent({
			event: "capture-started",
			timestampMs: 1_200,
			path: "/tmp/recording.mp4",
			width: 800,
			height: 600,
			fps: 30,
		});
		await flushStdout();
		await first;

		await expect(session.waitUntilCapturing()).resolves.toBeUndefined();
	});

	it("removes cursor samples from repeated pauses and compacts later timestamps", async () => {
		const now = vi.spyOn(Date, "now").mockReturnValue(900);
		const session = newSession();
		await startReady(session);

		emitCaptureStarted(1_000);
		emitCursorSample(1_100);
		await flushStdout();

		now.mockReturnValue(1_200);
		session.pause();
		emitCursorSample(1_250);
		now.mockReturnValue(1_400);
		session.resume();
		emitCursorSample(1_500);

		now.mockReturnValue(1_600);
		session.pause();
		emitCursorSample(1_650);
		now.mockReturnValue(1_800);
		session.resume();
		emitCursorSample(1_900);
		await flushStdout();

		now.mockReturnValue(2_000);
		const result = await finishCapture(session, 2_000);

		expect(result.cursor.samples.map((sample) => sample.timeMs)).toEqual([100, 300, 500]);
		expect(helper.stdinWrites.filter((line) => line === "pause\n")).toHaveLength(2);
		expect(helper.stdinWrites.filter((line) => line === "resume\n")).toHaveLength(2);
	});

	it("closes the cursor pause range when the recording stops while paused", async () => {
		const now = vi.spyOn(Date, "now").mockReturnValue(900);
		const session = newSession();
		await startReady(session);

		emitCaptureStarted(1_000);
		emitCursorSample(1_100);
		await flushStdout();

		now.mockReturnValue(1_200);
		session.pause();
		emitCursorSample(1_300);
		await flushStdout();

		now.mockReturnValue(1_500);
		const result = await finishCapture(session, 1_500);

		expect(result.cursor.samples.map((sample) => sample.timeMs)).toEqual([100]);
		expect(helper.stdinWrites).not.toContain("resume\n");
	});

	/**
	 * A non-fatal `error` event after the first frame does not end the capture;
	 * a later wait is still satisfied.
	 */
	it("resolves the capture wait after a non-fatal error follows the first frame", async () => {
		const session = newSession(true);
		await startReady(session);

		session.arm();
		helper.emitEvent({
			event: "capture-started",
			timestampMs: 1_200,
			path: "/tmp/recording.mp4",
			width: 800,
			height: 600,
			fps: 30,
		});
		helper.emitEvent({
			event: "error",
			timestampMs: 1_300,
			code: "audio-unavailable",
			message: "the system audio node vanished",
		});
		await flushStdout();

		await expect(session.waitUntilCapturing()).resolves.toBeUndefined();
	});

	/**
	 * A wait registered before the first frame stays pending until it lands.
	 */
	it("leaves the capture wait pending until the first frame lands", async () => {
		const session = newSession(true);
		await startReady(session);

		session.arm();
		let settled = false;
		const pending = session.waitUntilCapturing().then(() => {
			settled = true;
		});
		await flushStdout();
		expect(settled).toBe(false);

		helper.emitEvent({
			event: "capture-started",
			timestampMs: 1_200,
			path: "/tmp/recording.mp4",
			width: 800,
			height: 600,
			fps: 30,
		});
		await flushStdout();
		await pending;
		expect(settled).toBe(true);
	});

	describe("first-frame timeout (#1101)", () => {
		// Only the timers are faked: the fake helper's stdout still needs real
		// ticks to deliver its events, which `setImmediate` gives.
		const flushEvents = () => new Promise((resolve) => setImmediate(resolve));

		async function startFaked(deferStart = false) {
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
			const session = newSession(deferStart);
			const started = session.start();
			helper.emitEvent({ event: "ready", timestampMs: 1_000 });
			await flushEvents();
			await started;
			return session;
		}

		async function answerPicker() {
			helper.emitEvent({ event: "source-selected", timestampMs: 1_100, nodeId: 42 });
			await flushEvents();
		}

		afterEach(() => {
			vi.useRealTimers();
		});

		/**
		 * A stream that never delivers a frame and never reports an error used to
		 * leave the start hanging forever, with the HUD stuck before recording.
		 */
		it("fails the start and kills the helper when no frame follows the picker", async () => {
			const session = await startFaked(true);
			await answerPicker();

			// A countdown between the answer and the arm is not first-frame time.
			vi.advanceTimersByTime(60_000);
			expect(helper.killed).toBe(false);

			session.arm();
			const outcome = expect(session.waitUntilCapturing()).rejects.toThrow(
				/could not start screen capture/,
			);
			vi.advanceTimersByTime(9_999);
			expect(helper.killed).toBe(false);
			vi.advanceTimersByTime(1);

			await outcome;
			expect(helper.killed).toBe(true);
		});

		/** A human reading the picker has no upper bound; only what follows does. */
		it("does not start the clock until the picker has answered", async () => {
			const session = await startFaked();

			let settled = false;
			const capturing = session.waitUntilCapturing().finally(() => {
				settled = true;
			});
			const outcome = expect(capturing).rejects.toThrow(/could not start screen capture/);
			vi.advanceTimersByTime(600_000);
			await flushEvents();
			expect(settled).toBe(false);
			expect(helper.killed).toBe(false);

			await answerPicker();
			vi.advanceTimersByTime(10_000);

			await outcome;
			expect(helper.killed).toBe(true);
		});

		it("leaves a capture whose first frame arrived in time running", async () => {
			const session = await startFaked();

			const capturing = session.waitUntilCapturing();
			await answerPicker();
			vi.advanceTimersByTime(9_000);
			helper.emitEvent({
				event: "capture-started",
				timestampMs: 1_200,
				path: "/tmp/recording.mp4",
				width: 800,
				height: 600,
				fps: 30,
			});
			await flushEvents();
			await capturing;

			vi.advanceTimersByTime(60_000);
			expect(helper.killed).toBe(false);
		});
	});

	/**
	 * Save Diagnostics' `helperOutput.linux`. Before it, a Linux bundle had no entry for
	 * the helper at all, where Windows and macOS keep their helper's raw output.
	 */
	describe("helper output", () => {
		it("keeps the helper's stderr and events past its exit, without cursor samples", async () => {
			const session = newSession();
			await startReady(session);
			helper.stderr.write("pipewire: format negotiated\n");
			helper.emitEvent({ event: "encoder-selection", video: "h264_vaapi" });
			helper.emitEvent({
				event: "cursor-sample",
				timestampMs: 1_150,
				x: 10,
				y: 20,
				width: 1280,
				height: 720,
				visible: true,
			});
			helper.emitEvent({ event: "warning", code: "dmabuf", message: "falling back to shm" });
			await flushStdout();
			helper.emit("exit", 1, null);

			const output = session.helperOutput;
			expect(output).toContain('"event":"ready"');
			expect(output).toContain("pipewire: format negotiated\n");
			expect(output).toContain('"video":"h264_vaapi"');
			expect(output).toContain('"message":"falling back to shm"');
			expect(output).not.toContain("cursor-sample");
		});

		it("keeps a line the helper wrote that is not JSON", async () => {
			const session = newSession();
			await startReady(session);
			helper.stdout.write("thread 'main' panicked at src/main.rs:12\n");
			await flushStdout();

			expect(session.helperOutput).toContain("thread 'main' panicked at src/main.rs:12\n");
		});

		it("keeps the newest 64 KiB of a helper that keeps talking", async () => {
			const session = newSession();
			await startReady(session);
			for (let i = 0; i < 1_000; i += 1) {
				helper.stderr.write(`warning ${i} ${"x".repeat(100)}\n`);
			}
			await flushStdout();

			expect(session.helperOutput.length).toBe(64 * 1024);
			expect(session.helperOutput).toContain("warning 999 ");
			expect(session.helperOutput).not.toContain('"event":"ready"');
		});

		it("counts the cap in UTF-8 bytes and cuts it between characters", async () => {
			const session = newSession();
			await startReady(session);
			// 90 000 bytes of a 3-byte character: the 64 KiB cut lands 2 bytes into one,
			// so the whole characters that fit are the 21 845 after it.
			helper.stderr.write("€".repeat(30_000));
			await flushStdout();

			expect(Buffer.byteLength(session.helperOutput, "utf8")).toBeLessThanOrEqual(64 * 1024);
			expect(session.helperOutput).toBe("€".repeat(21_845));
		});
	});
});
