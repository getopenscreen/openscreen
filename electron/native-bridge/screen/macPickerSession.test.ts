import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
	isMacPickerSourceId,
	MacPickerSession,
	parsePickerSelection,
	supportsMacSystemPicker,
} from "./macPickerSession";

/** The `--picker-session` helper, driven by hand: what it hears, and a way to speak. */
class FakeSessionHelper extends EventEmitter {
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

	it("ends a running take and forgets the pick when the session dies", async () => {
		const { helper, session } = await pickDisplay();
		const take = session.startTake({});
		const closed = new Promise((resolve) => take.once("close", (_code, signal) => resolve(signal)));
		helper.kill();
		expect(await closed).toBe("SIGTERM");
		expect(session.getSelection()).toBeNull();
	});
});

describe("isMacPickerSourceId", () => {
	it("tells a picked source from a desktopCapturer id", () => {
		expect(isMacPickerSourceId("mac-picker:display:1")).toBe(true);
		expect(isMacPickerSourceId("screen:1:0")).toBe(false);
		expect(isMacPickerSourceId(undefined)).toBe(false);
	});
});
