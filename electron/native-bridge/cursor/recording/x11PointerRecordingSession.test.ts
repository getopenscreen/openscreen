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
});
