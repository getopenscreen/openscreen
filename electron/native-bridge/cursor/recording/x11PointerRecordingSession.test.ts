import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getCursorScreenPoint = vi.fn(() => ({ x: 96, y: 54 }));
const getDisplayNearestPoint = vi.fn(() => ({
	bounds: { x: 0, y: 0, width: 1920, height: 1080 },
}));

vi.mock("electron", () => ({
	screen: {
		getCursorScreenPoint: () => getCursorScreenPoint(),
		getDisplayNearestPoint: () => getDisplayNearestPoint(),
	},
}));

import { X11PointerRecordingSession } from "./x11PointerRecordingSession";

describe("X11PointerRecordingSession", () => {
	const REAL_PLATFORM = process.platform;
	const setPlatform = (value: NodeJS.Platform) =>
		Object.defineProperty(process, "platform", { value, configurable: true });

	beforeEach(() => {
		setPlatform("linux");
		vi.useFakeTimers();
		vi.setSystemTime(1_000);
		getCursorScreenPoint.mockReturnValue({ x: 96, y: 54 });
	});

	afterEach(() => {
		setPlatform(REAL_PLATFORM);
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("records normalised move samples and injected clicks", async () => {
		const buttons: {
			onPress: (button: number) => void;
			onRelease: (button: number) => void;
		} = {
			onPress: () => undefined,
			onRelease: () => undefined,
		};
		const session = new X11PointerRecordingSession({
			getDisplayBounds: () => ({ x: 0, y: 0, width: 1920, height: 1080 }),
			maxSamples: 100,
			sampleIntervalMs: 33,
			startTimeMs: 1_000,
			getPoint: () => getCursorScreenPoint(),
			watchButtons: (handlers) => {
				buttons.onPress = handlers.onPress;
				buttons.onRelease = handlers.onRelease;
				return () => undefined;
			},
		});

		await session.start();
		vi.setSystemTime(1_100);
		buttons.onPress(1);
		vi.setSystemTime(1_160);
		buttons.onRelease(1);
		const data = await session.stop();

		expect(data.version).toBe(2);
		expect(data.provider).toBe("none");
		expect(data.samples[0]).toMatchObject({
			timeMs: 0,
			cx: 96 / 1920,
			cy: 54 / 1080,
			visible: true,
			interactionType: "move",
		});
		const types = data.samples.map((sample) => sample.interactionType);
		expect(types).toContain("click");
		expect(types).toContain("mouseup");
	});

	it("uses an injected getPoint instead of Electron", async () => {
		const session = new X11PointerRecordingSession({
			getDisplayBounds: () => ({ x: 0, y: 0, width: 100, height: 100 }),
			maxSamples: 10,
			sampleIntervalMs: 33,
			startTimeMs: 1_000,
			getPoint: () => ({ x: 25, y: 75 }),
			watchButtons: () => () => undefined,
		});
		await session.start();
		const data = await session.stop();
		expect(data.samples[0]).toMatchObject({ cx: 0.25, cy: 0.75 });
	});

	it("advances to the next click watcher when a child exits", async () => {
		const commands: string[] = [];
		const spawnFn = (command: string) => {
			commands.push(command);
			const child = new EventEmitter() as EventEmitter & {
				stdout: PassThrough;
				stderr: PassThrough;
				killed: boolean;
				kill: () => boolean;
			};
			child.stdout = new PassThrough();
			child.stderr = new PassThrough();
			child.killed = false;
			child.kill = () => {
				child.killed = true;
				return true;
			};
			queueMicrotask(() => child.emit("exit", 1, null));
			return child;
		};
		const session = new X11PointerRecordingSession(
			{
				getDisplayBounds: () => ({ x: 0, y: 0, width: 1920, height: 1080 }),
				maxSamples: 10,
				sampleIntervalMs: 33,
				startTimeMs: 1_000,
				getPoint: () => ({ x: 1, y: 1 }),
			},
			spawnFn as unknown as ConstructorParameters<typeof X11PointerRecordingSession>[1],
		);
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		await session.start();
		for (let i = 0; i < 8; i++) {
			await Promise.resolve();
		}
		await session.stop();
		expect(commands).toEqual(["xinput", "xev", "libinput"]);
		expect(warn.mock.calls.some((call) => String(call[0]).includes("using xev -root"))).toBe(true);
	});
	it("does not guess a monitor when capture geometry is unknown", async () => {
		const session = new X11PointerRecordingSession({
			getDisplayBounds: () => null,
			getPoint: () => ({ x: 100, y: 100 }),
			watchButtons: () => () => undefined,
			maxSamples: 100,
			sampleIntervalMs: 33,
		});
		await session.start();
		await vi.advanceTimersByTimeAsync(100);
		expect((await session.stop()).samples).toEqual([]);
		expect(getDisplayNearestPoint).not.toHaveBeenCalled();
	});

	it("keeps coordinates relative to the captured monitor when the pointer crosses monitors", async () => {
		let point = { x: -960, y: 540 };
		let press: (button: number) => void = () => undefined;
		const session = new X11PointerRecordingSession({
			getDisplayBounds: () => ({ x: -1920, y: 0, width: 1920, height: 1080 }),
			getPoint: () => point,
			watchButtons: (handlers) => {
				press = handlers.onPress;
				return () => undefined;
			},
			maxSamples: 100,
			sampleIntervalMs: 33,
		});
		await session.start();
		point = { x: 960, y: 540 };
		await vi.advanceTimersByTimeAsync(33);
		press(1);
		const data = await session.stop();
		expect(data.samples).toHaveLength(2);
		expect(data.samples[0]).toMatchObject({ cx: 0.5, cy: 0.5, visible: true });
		expect(data.samples[1]).toMatchObject({
			cx: 1,
			cy: 0.5,
			visible: false,
			interactionType: "move",
		});
	});

	it("stops timers and button watchers, and starting twice does not leak a timer", async () => {
		const dispose = vi.fn();
		const watchButtons = vi.fn(() => dispose);
		const session = new X11PointerRecordingSession({
			getDisplayBounds: () => ({ x: 0, y: 0, width: 100, height: 100 }),
			getPoint: () => ({ x: 0, y: 0 }),
			watchButtons,
			maxSamples: 100,
			sampleIntervalMs: 33,
		});
		await session.start();
		await session.start();
		expect(watchButtons).toHaveBeenCalledTimes(1);
		const data = await session.stop();
		await vi.advanceTimersByTimeAsync(100);
		expect(data.samples).toHaveLength(1);
		expect(dispose).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(0);
	});
	it("records raw global clicks once and ignores buffered data after stop", async () => {
		const child = new EventEmitter() as EventEmitter & {
			stdout: PassThrough;
			stderr: PassThrough;
			killed: boolean;
			kill: () => boolean;
		};
		child.stdout = new PassThrough();
		child.stderr = new PassThrough();
		child.killed = false;
		child.kill = () => {
			child.killed = true;
			return true;
		};
		const session = new X11PointerRecordingSession(
			{
				getDisplayBounds: () => ({ x: 0, y: 0, width: 100, height: 100 }),
				getPoint: () => ({ x: 25, y: 75 }),
				maxSamples: 100,
				sampleIntervalMs: 33,
			},
			(() => child) as unknown as ConstructorParameters<typeof X11PointerRecordingSession>[1],
		);
		await session.start();
		const press = "EVENT type 15 (RawButtonPress)\n    device: 2 (12)\n    detail: 1\n";
		child.stdout.write(press.replace("15 (RawButtonPress)", "4 (ButtonPress)") + press);
		const data = await session.stop();
		child.stdout.write(press);
		expect(data.samples.map((sample) => sample.interactionType)).toEqual(["move", "click"]);
		expect(data.samples[1]).toMatchObject({ cx: 0.25, cy: 0.75 });
		expect(child.killed).toBe(true);
	});
	it("retains click event times while fresh queries finish out of order, and drains them on stop", async () => {
		const callbacks: ((point: { x: number; y: number }) => void)[] = [];
		let first = true;
		let buttons: { onPress: (button: number) => void; onRelease: (button: number) => void } = {
			onPress: () => undefined,
			onRelease: () => undefined,
		};
		const dispose = vi.fn();
		const session = new X11PointerRecordingSession({
			getDisplayBounds: () => ({ x: 0, y: 0, width: 100, height: 100 }),
			getPoint: () => {
				if (first) {
					first = false;
					return { x: 10, y: 10 };
				}
				return new Promise((resolve) => callbacks.push(resolve));
			},
			watchButtons: (handlers) => {
				buttons = handlers;
				return dispose;
			},
			maxSamples: 100,
			sampleIntervalMs: 1000,
			startTimeMs: 1000,
		});
		await session.start();
		vi.setSystemTime(1100);
		buttons.onPress(1);
		vi.setSystemTime(1110);
		buttons.onRelease(1);
		let stopped = false;
		const result = session.stop().then((data) => {
			stopped = true;
			return data;
		});
		await Promise.resolve();
		expect(stopped).toBe(false);
		expect(dispose).toHaveBeenCalledOnce();
		vi.setSystemTime(1200);
		callbacks[1]({ x: 75, y: 50 });
		callbacks[0]({ x: 75, y: 50 });
		const data = await result;
		expect(data.samples.map(({ timeMs, interactionType }) => [timeMs, interactionType])).toEqual([
			[0, "move"],
			[100, "click"],
			[110, "mouseup"],
		]);
		expect(data.samples[1]).toMatchObject({ cx: 0.75, cy: 0.5 });
		expect(vi.getTimerCount()).toBe(0);
	});
	it("does not pile up polling children while a fresh move query is outstanding", async () => {
		let finish: (point: { x: number; y: number }) => void = () => undefined;
		const getPoint = vi.fn(
			() =>
				new Promise<{ x: number; y: number }>((resolve) => {
					finish = resolve;
				}),
		);
		const session = new X11PointerRecordingSession({
			getDisplayBounds: () => ({ x: 0, y: 0, width: 100, height: 100 }),
			getPoint,
			watchButtons: () => () => undefined,
			maxSamples: 100,
			sampleIntervalMs: 33,
		});
		await session.start();
		await vi.advanceTimersByTimeAsync(100);
		expect(getPoint).toHaveBeenCalledOnce();
		const stopped = session.stop();
		finish({ x: 25, y: 25 });
		expect((await stopped).samples).toHaveLength(1);
	});
});
