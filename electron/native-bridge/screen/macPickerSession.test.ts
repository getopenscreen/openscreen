import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import {
	isMacPickerSourceId,
	MacPickerSession,
	parsePickerSelection,
	supportsMacSystemPicker,
} from "./macPickerSession";

/** The `--picker-session` helper, driven by hand: what it hears, and a way to speak. */
class FakeSessionHelper extends EventEmitter {
	pid = 4242;
	stdin = new PassThrough();
	stdout = new PassThrough();
	stderr = new PassThrough();
	commands: string[] = [];

	constructor() {
		super();
		this.stdin.on("data", (chunk: Buffer) => {
			this.commands.push(...chunk.toString().split("\n").filter(Boolean));
		});
	}

	say(event: Record<string, unknown>) {
		this.stdout.write(`${JSON.stringify(event)}\n`);
	}

	kill() {
		this.emit("close", null, "SIGTERM");
		return true;
	}

	/** The helper going away on its own, as a crash or an early exit would. */
	exit(code: number | null, signal: NodeJS.Signals | null = null) {
		this.emit("close", code, signal);
	}
}

// The session logs every step of the picker (#1021); keep that out of the test output, and
// let the tests that are about the logging read it back.
let info: MockInstance<typeof console.info>;
let warn: MockInstance<typeof console.warn>;
beforeEach(() => {
	info = vi.spyOn(console, "info").mockImplementation(() => undefined);
	warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
	vi.restoreAllMocks();
});

function logged(spy: MockInstance<typeof console.info>) {
	return spy.mock.calls.map((args) => args.map(String).join(" "));
}

const DISPLAY_PICK = {
	event: "picker-selected",
	kind: "display",
	displayId: 1,
	bounds: { x: 0, y: 0, width: 1920, height: 1080 },
	pointPixelScale: 2,
};

async function flush() {
	await new Promise((resolve) => setImmediate(resolve));
}

async function readySession() {
	const helper = new FakeSessionHelper();
	const spawnHelper = vi.fn(() => helper);
	const session = new MacPickerSession("/helper", spawnHelper as never);
	const started = session.start();
	helper.say({ event: "picker-session-ready" });
	expect(await started).toBe(true);
	expect(spawnHelper).toHaveBeenCalledWith("/helper", ["--picker-session"], expect.anything());
	return { helper, session };
}

async function pickDisplay() {
	const ready = await readySession();
	const pick = ready.session.present([7, 8]);
	await flush();
	ready.helper.say(DISPLAY_PICK);
	expect(await pick).not.toBeNull();
	return ready;
}

function lines(stream: PassThrough) {
	const seen: string[] = [];
	stream.on("data", (chunk: Buffer) => seen.push(...chunk.toString().split("\n").filter(Boolean)));
	return seen;
}

describe("supportsMacSystemPicker", () => {
	it("starts at 15.2, where the pick can be located on screen", () => {
		expect(supportsMacSystemPicker("15.1.1")).toBe(false);
		expect(supportsMacSystemPicker("15.2")).toBe(true);
		expect(supportsMacSystemPicker("26.5.0")).toBe(true);
		expect(supportsMacSystemPicker("14.7")).toBe(false);
	});
});

describe("parsePickerSelection", () => {
	it("reads a window pick with its title and frame", () => {
		expect(
			parsePickerSelection({
				event: "picker-selected",
				kind: "window",
				windowId: 42,
				displayId: 1,
				title: "Notes",
				appName: "Notes",
				bounds: { x: 10, y: 20, width: 300, height: 200 },
			}),
		).toEqual({
			kind: "window",
			windowId: 42,
			displayId: 1,
			title: "Notes",
			appName: "Notes",
			bounds: { x: 10, y: 20, width: 300, height: 200 },
		});
	});

	it("refuses a pick it cannot place on screen", () => {
		expect(parsePickerSelection({ event: "picker-selected", kind: "display" })).toBeNull();
	});
});

describe("MacPickerSession", () => {
	it("falls back when the helper never reports ready", async () => {
		vi.useFakeTimers();
		try {
			const helper = new FakeSessionHelper();
			const session = new MacPickerSession("/helper", (() => helper) as never);
			const started = session.start();
			await vi.advanceTimersByTimeAsync(5_000);
			expect(await started).toBe(false);
		} finally {
			vi.useRealTimers();
		}
	});

	it("presents the picker with the app's windows excluded, and keeps the pick", async () => {
		const { helper, session } = await readySession();

		const pick = session.present([7, 8], true);
		await flush();
		expect(JSON.parse(helper.commands[0] ?? "{}")).toMatchObject({
			command: "present",
			excludedWindowIds: [7, 8],
			hideDesktopIcons: true,
		});

		helper.say(DISPLAY_PICK);
		expect(await pick).toMatchObject({ kind: "display", displayId: 1 });
		expect(session.getSelection()).toMatchObject({ bounds: { width: 1920 } });
	});

	it("answers null when the user cancels", async () => {
		const { helper, session } = await readySession();
		const pick = session.present([]);
		await flush();
		helper.say({ event: "picker-cancelled" });
		expect(await pick).toBeNull();
		expect(session.getSelection()).toBeNull();
	});

	it("refuses to start a take before anything was picked", async () => {
		const { session } = await readySession();
		expect(() => session.startTake({})).toThrow(/Pick a screen or window/);
	});

	it("hands each take only its own events, and ends it on take-ended", async () => {
		const { helper, session } = await pickDisplay();

		const first = session.startTake({ video: { fps: 30 } });
		const firstLines = lines(first.stdout as PassThrough);
		const closed = new Promise((resolve) => first.once("close", (code) => resolve(code)));
		await flush();
		expect(JSON.parse(helper.commands.at(-1) ?? "{}")).toMatchObject({ command: "start" });

		helper.say({
			event: "recording-started",
			captureBounds: { x: 0, y: 0, width: 1920, height: 1080 },
		});
		first.stdin.write("stop\n");
		await flush();
		expect(helper.commands.at(-1)).toBe("stop");
		helper.say({ event: "recording-stopped", screenPath: "/a.mp4" });
		helper.say({ event: "take-ended" });
		expect(await closed).toBe(0);
		expect(firstLines.map((line) => JSON.parse(line).event)).toEqual([
			"recording-started",
			"recording-stopped",
		]);

		// The second take starts from the same pick and sees none of the first one's output.
		const second = session.startTake({ video: { fps: 30 } });
		const secondLines = lines(second.stdout as PassThrough);
		helper.say({ event: "recording-started" });
		await flush();
		expect(secondLines.map((line) => JSON.parse(line).event)).toEqual(["recording-started"]);
	});

	it("reports a take that failed without a file as a failed exit", async () => {
		const { helper, session } = await pickDisplay();
		const take = session.startTake({});
		const closed = new Promise((resolve) => take.once("close", (code) => resolve(code)));
		helper.say({ event: "error", code: "helper-error", message: "boom" });
		helper.say({ event: "take-ended" });
		expect(await closed).toBe(1);
	});

	it("stops the take, not the session, when the take is killed", async () => {
		const { helper, session } = await pickDisplay();
		const take = session.startTake({});
		take.kill();
		await flush();
		expect(helper.commands.at(-1)).toBe("stop");
	});

	it("forgets a screen pick once an app window it does not leave out must be (#965)", async () => {
		const { session } = await pickDisplay();

		// The windows the picker was told about, in any order, or fewer of them: still good.
		session.forgetSelectionUnlessExcluding([8, 7]);
		session.forgetSelectionUnlessExcluding([7]);
		expect(session.getSelection()).not.toBeNull();

		// The HUD came back from the editor as a new window: the pick would record it.
		session.forgetSelectionUnlessExcluding([9]);
		expect(session.getSelection()).toBeNull();
	});

	it("keeps a screen pick that leaves out the whole app, new windows included (#996)", async () => {
		const { helper, session } = await readySession();
		// Picked in the editor's Record mode: the HUD does not exist yet.
		const pick = session.present([7]);
		await flush();
		helper.say({ ...DISPLAY_PICK, excludesApp: true });
		expect(await pick).not.toBeNull();

		// Start recording brought the HUD back as a window the picker was never told about.
		session.forgetSelectionUnlessExcluding([9]);
		expect(session.getSelection()).not.toBeNull();
	});

	it("goes back to checking window ids once a later pick does not leave out the app", async () => {
		const { helper, session } = await readySession();
		const first = session.present([7]);
		await flush();
		helper.say({ ...DISPLAY_PICK, excludesApp: true });
		expect(await first).not.toBeNull();

		const second = session.present([7]);
		await flush();
		helper.say(DISPLAY_PICK);
		expect(await second).not.toBeNull();

		session.forgetSelectionUnlessExcluding([9]);
		expect(session.getSelection()).toBeNull();
	});

	it("keeps the exclusions of the pick, not of a picker that was cancelled", async () => {
		const { helper, session } = await pickDisplay();
		const cancelled = session.present([9]);
		await flush();
		helper.say({ event: "picker-cancelled" });
		expect(await cancelled).toBeNull();

		session.forgetSelectionUnlessExcluding([7, 8]);
		expect(session.getSelection()).not.toBeNull();
		session.forgetSelectionUnlessExcluding([9]);
		expect(session.getSelection()).toBeNull();
	});

	it("keeps a window pick whatever the app's windows are", async () => {
		const { helper, session } = await readySession();
		const pick = session.present([7]);
		await flush();
		helper.say({ ...DISPLAY_PICK, kind: "window", windowId: 42 });
		expect(await pick).not.toBeNull();

		session.forgetSelectionUnlessExcluding([9]);
		expect(session.getSelection()).toMatchObject({ kind: "window" });
	});

	it("keeps the pick while a take is running from it", async () => {
		const { helper, session } = await pickDisplay();
		session.startTake({});

		// The notes window opened mid-take: the running take still reads the pick's frame.
		session.forgetSelectionUnlessExcluding([7, 8, 9]);
		expect(session.getSelection()).not.toBeNull();

		helper.say({ event: "take-ended" });
		await flush();
		session.forgetSelectionUnlessExcluding([7, 8, 9]);
		expect(session.getSelection()).toBeNull();
	});

	it("ends a running take and forgets the pick when the session dies", async () => {
		const { helper, session } = await pickDisplay();
		const take = session.startTake({});
		const closed = new Promise((resolve) => take.once("close", (_code, signal) => resolve(signal)));
		helper.kill();
		expect(await closed).toBe("SIGTERM");
		expect(session.getSelection()).toBeNull();
	});
});

describe("MacPickerSession, as the Terminal output tells it (#1021)", () => {
	it("traces a pick from the session's start to the answer", async () => {
		const { helper, session } = await readySession();
		const pick = session.present([7]);
		await flush();
		helper.say({ ...DISPLAY_PICK, kind: "window", windowId: 42, title: "Q3 layoffs.key" });
		expect(await pick).not.toBeNull();

		expect(logged(info)).toEqual([
			"[mac-picker] picker session started (pid 4242)",
			"[mac-picker] showing Apple's picker",
			"[mac-picker] picked a window (1920x1080)",
		]);
		// A window's title can say anything, and these lines get pasted into public issues.
		expect(logged(info).join("\n")).not.toContain("layoffs");
	});

	it("says when the user cancelled", async () => {
		const { helper, session } = await readySession();
		const pick = session.present([]);
		await flush();
		helper.say({ event: "picker-cancelled" });
		expect(await pick).toBeNull();
		expect(logged(info)).toContain("[mac-picker] the picker was cancelled");
	});

	it("says the helper died while Apple's picker was up, and answers nothing", async () => {
		const { helper, session } = await readySession();
		const pick = session.present([]);
		await flush();
		helper.exit(null, "SIGSEGV");
		expect(await pick).toBeNull();
		expect(logged(warn)).toEqual([
			"[mac-picker] the picker session exited (signal SIGSEGV) while Apple's picker was up",
		]);
	});

	it("says the helper exited during a take, with its exit code", async () => {
		const { helper, session } = await pickDisplay();
		session.startTake({});
		helper.exit(1);
		await flush();
		expect(logged(warn)).toEqual(["[mac-picker] the picker session exited (code 1) during a take"]);
	});

	it("stays quiet when the app ended the session itself", async () => {
		const { helper, session } = await pickDisplay();
		session.dispose();
		helper.exit(0);
		await flush();
		expect(logged(warn)).toEqual([]);
	});

	it("answers at once when the picker cannot be shown, instead of waiting on the helper", async () => {
		const { helper, session } = await readySession();
		helper.stdin.end();
		expect(await session.present([])).toBeNull();
		expect(logged(warn)).toEqual([
			"[mac-picker] could not reach the picker session to show the picker",
		]);
	});
});

describe("isMacPickerSourceId", () => {
	it("tells a picked source from a desktopCapturer id", () => {
		expect(isMacPickerSourceId("mac-picker:display:1")).toBe(true);
		expect(isMacPickerSourceId("screen:1:0")).toBe(false);
		expect(isMacPickerSourceId(undefined)).toBe(false);
	});
});
