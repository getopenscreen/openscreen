import net from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HyprlandCursorTracker, mapHyprlandCursorToCapture } from "./hyprlandCursorTracker";

const originalRuntime = process.env.XDG_RUNTIME_DIR;
const originalSignature = process.env.HYPRLAND_INSTANCE_SIGNATURE;

afterEach(() => {
	if (originalRuntime === undefined) delete process.env.XDG_RUNTIME_DIR;
	else process.env.XDG_RUNTIME_DIR = originalRuntime;
	if (originalSignature === undefined) delete process.env.HYPRLAND_INSTANCE_SIGNATURE;
	else process.env.HYPRLAND_INSTANCE_SIGNATURE = originalSignature;
	vi.restoreAllMocks();
});

describe("mapHyprlandCursorToCapture", () => {
	it("maps a monitor with a non-zero origin and Y offset", () => {
		const result = mapHyprlandCursorToCapture(
			{ x: 5058, y: 673 },
			[
				{ x: 0, y: 494, width: 1366, height: 768, scale: 1 },
				{ x: 1366, y: 236, width: 2560, height: 1600, scale: 1 },
				{ x: 3926, y: 0, width: 3840, height: 2160, scale: 1 },
			],
			{ x: 3926, y: 0, width: 3840, height: 2160 },
		);

		expect(result).toEqual({ cx: 1132 / 3840, cy: 673 / 2160 });
	});

	it("supports negative origins and fractional scaling", () => {
		const result = mapHyprlandCursorToCapture(
			{ x: -640, y: 100 },
			[{ x: -1280, y: 0, width: 1280, height: 720, scale: 2 }],
			{ x: -1280, y: 0, width: 1280, height: 720 },
		);

		expect(result.cx).toBeCloseTo(0.5);
		expect(result.cy).toBeCloseTo(100 / 720);
	});

	it("rotates coordinates for transformed monitors", () => {
		const result = mapHyprlandCursorToCapture(
			{ x: 25, y: 50 },
			[{ x: 0, y: 0, width: 100, height: 200, scale: 1, transform: 1 }],
			{ x: 0, y: 0, width: 100, height: 200 },
		);

		expect(result).toEqual({ cx: 0.75, cy: 0.25 });
	});

	it("clamps cursor positions outside a selected recording region", () => {
		expect(
			mapHyprlandCursorToCapture({ x: 2000, y: -100 }, [], {
				x: 0,
				y: 0,
				width: 1000,
				height: 1000,
			}),
		).toEqual({ cx: 1, cy: 0 });
	});

	it("recovers from an IPC disconnect without spawning a process per sample", async () => {
		process.env.XDG_RUNTIME_DIR = "/tmp/openscreen-hypr-runtime";
		process.env.HYPRLAND_INSTANCE_SIGNATURE = "test-instance";
		let connections = 0;
		vi.spyOn(net, "createConnection").mockImplementation(() => {
			connections++;
			const listeners = new Map<string, (...args: unknown[]) => void>();
			const socket = {
				writable: true,
				destroyed: false,
				setTimeout: () => socket,
				on: (event: string, listener: (...args: unknown[]) => void) => {
					listeners.set(event, listener);
					if (event === "connect") queueMicrotask(listener);
					return socket;
				},
				write: (command: string) => {
					if (connections === 1) {
						listeners.get("error")?.(new Error("compositor restarted"));
						return true;
					}
					if (command === "j/cursorpos") listeners.get("data")?.('{"x":50,"y":25}');
					if (command === "j/monitors") {
						listeners.get("data")?.(
							'[{"x":0,"y":0,"width":100,"height":50,"scale":1,"transform":0}]',
						);
					}
					return true;
				},
				destroy: () => {
					socket.destroyed = true;
				},
			};
			return socket as unknown as net.Socket;
		});

		const tracker = new HyprlandCursorTracker({ sampleIntervalMs: 20, maxSamples: 10 });
		tracker.setCaptureRect({ x: 0, y: 0, width: 100, height: 50 });
		tracker.start();
		await new Promise((resolve) => setTimeout(resolve, 120));
		const result = tracker.stop();

		expect(connections).toBeGreaterThanOrEqual(2);
		expect(result.samples.length).toBeGreaterThan(0);
	});

	it("resolves an omitted portal origin from a matching Hyprland monitor", async () => {
		process.env.XDG_RUNTIME_DIR = "/tmp/openscreen-hypr-runtime";
		process.env.HYPRLAND_INSTANCE_SIGNATURE = "geometry-fallback";
		vi.spyOn(net, "createConnection").mockImplementation(() => {
			const listeners = new Map<string, (...args: unknown[]) => void>();
			const socket = {
				writable: true,
				destroyed: false,
				setTimeout: () => socket,
				on: (event: string, listener: (...args: unknown[]) => void) => {
					listeners.set(event, listener);
					if (event === "connect") queueMicrotask(listener);
					return socket;
				},
				write: (command: string) => {
					if (command === "j/cursorpos") listeners.get("data")?.('{"x":1500,"y":500}');
					if (command === "j/monitors") {
						listeners.get("data")?.(
							'[{"x":0,"y":494,"width":1366,"height":768,"scale":1,"transform":0},{"x":1366,"y":236,"width":2560,"height":1600,"scale":1,"transform":0}]',
						);
					}
					return true;
				},
				destroy: () => {
					socket.destroyed = true;
				},
			};
			return socket as unknown as net.Socket;
		});

		const tracker = new HyprlandCursorTracker({ sampleIntervalMs: 10, maxSamples: 10 });
		tracker.setCaptureGeometry({ width: 2560, height: 1600 });
		tracker.start();
		await new Promise((resolve) => setTimeout(resolve, 120));

		const sample = tracker.stop().samples[0];
		expect(sample).toMatchObject({ cx: 134 / 2560, cy: 264 / 1600, visible: true });
	});

	it("matches a scaled monitor using its logical capture size", async () => {
		process.env.XDG_RUNTIME_DIR = "/tmp/openscreen-hypr-runtime";
		process.env.HYPRLAND_INSTANCE_SIGNATURE = "scaled-geometry-fallback";
		vi.spyOn(net, "createConnection").mockImplementation(() => {
			const listeners = new Map<string, (...args: unknown[]) => void>();
			const socket = {
				writable: true,
				destroyed: false,
				setTimeout: () => socket,
				on: (event: string, listener: (...args: unknown[]) => void) => {
					listeners.set(event, listener);
					if (event === "connect") queueMicrotask(listener);
					return socket;
				},
				write: (command: string) => {
					if (command === "j/cursorpos") listeners.get("data")?.('{"x":500,"y":300}');
					if (command === "j/monitors") {
						listeners.get("data")?.(
							'[{"x":0,"y":0,"width":2560,"height":1600,"scale":2,"transform":0}]',
						);
					}
					return true;
				},
				destroy: () => {
					socket.destroyed = true;
				},
			};
			return socket as unknown as net.Socket;
		});

		const tracker = new HyprlandCursorTracker({ sampleIntervalMs: 10, maxSamples: 10 });
		tracker.setCaptureGeometry({ width: 1280, height: 800 });
		tracker.start();
		await new Promise((resolve) => setTimeout(resolve, 60));

		const sample = tracker.stop().samples[0];
		expect(sample).toMatchObject({ cx: 500 / 1280, cy: 300 / 800, visible: true });
	});

	it("does not invent a window origin when the portal omits it", async () => {
		process.env.XDG_RUNTIME_DIR = "/tmp/openscreen-hypr-runtime";
		process.env.HYPRLAND_INSTANCE_SIGNATURE = "window-geometry-fallback";
		vi.spyOn(net, "createConnection").mockImplementation(() => {
			const listeners = new Map<string, (...args: unknown[]) => void>();
			const socket = {
				writable: true,
				destroyed: false,
				setTimeout: () => socket,
				on: (event: string, listener: (...args: unknown[]) => void) => {
					listeners.set(event, listener);
					if (event === "connect") queueMicrotask(listener);
					return socket;
				},
				write: (command: string) => {
					if (command === "j/cursorpos") listeners.get("data")?.('{"x":1500,"y":500}');
					if (command === "j/monitors") {
						listeners.get("data")?.(
							'[{"x":0,"y":494,"width":1366,"height":768,"scale":1,"transform":0},{"x":1366,"y":236,"width":2560,"height":1600,"scale":1,"transform":0}]',
						);
					}
					return true;
				},
				destroy: () => {
					socket.destroyed = true;
				},
			};
			return socket as unknown as net.Socket;
		});

		const tracker = new HyprlandCursorTracker({ sampleIntervalMs: 10, maxSamples: 10 });
		tracker.setCaptureGeometry({ width: 1234, height: 720, allowMonitorOriginFallback: false });
		tracker.start();
		await new Promise((resolve) => setTimeout(resolve, 60));

		expect(tracker.stop().samples).toEqual([]);
	});

	it("corrects a zero portal origin for a uniquely sized monitor", async () => {
		process.env.XDG_RUNTIME_DIR = "/tmp/openscreen-hypr-runtime";
		process.env.HYPRLAND_INSTANCE_SIGNATURE = "exact-monitor-origin";
		vi.spyOn(net, "createConnection").mockImplementation(() => {
			const listeners = new Map<string, (...args: unknown[]) => void>();
			const socket = {
				writable: true,
				destroyed: false,
				setTimeout: () => socket,
				on: (event: string, listener: (...args: unknown[]) => void) => {
					listeners.set(event, listener);
					if (event === "connect") queueMicrotask(listener);
					return socket;
				},
				write: (command: string) => {
					if (command === "j/cursorpos") listeners.get("data")?.('{"x":4479,"y":1080}');
					if (command === "j/monitors") {
						listeners.get("data")?.(
							'[{"x":1366,"y":236,"width":2560,"height":1600},{"x":3926,"y":0,"width":3840,"height":2160}]',
						);
					}
					return true;
				},
				destroy: () => {
					socket.destroyed = true;
				},
			};
			return socket as unknown as net.Socket;
		});

		const tracker = new HyprlandCursorTracker({ sampleIntervalMs: 10, maxSamples: 5 });
		tracker.setCaptureGeometry({ position: { x: 0, y: 0 }, width: 3840, height: 2160 });
		tracker.start();
		await new Promise((resolve) => setTimeout(resolve, 30));
		const sample = tracker.stop().samples[0];

		expect(sample?.cx).toBeCloseTo((4479 - 3926) / 3840);
		expect(sample?.cy).toBeCloseTo(1080 / 2160);
	});

	it("does not produce samples when the Hyprland socket is unavailable", async () => {
		process.env.XDG_RUNTIME_DIR = "/tmp/openscreen-no-such-runtime";
		process.env.HYPRLAND_INSTANCE_SIGNATURE = "missing";
		const tracker = new HyprlandCursorTracker({ sampleIntervalMs: 10, maxSamples: 10 });
		tracker.setCaptureRect({ x: 0, y: 0, width: 100, height: 50 });
		tracker.start();
		await new Promise((resolve) => setTimeout(resolve, 40));
		expect(tracker.stop().samples).toEqual([]);
	});

	it("rebases timestamps and excludes paused time", async () => {
		process.env.XDG_RUNTIME_DIR = "/tmp/openscreen-hypr-runtime";
		process.env.HYPRLAND_INSTANCE_SIGNATURE = "timestamp-test";
		vi.spyOn(net, "createConnection").mockImplementation(() => {
			const listeners = new Map<string, (...args: unknown[]) => void>();
			const socket = {
				writable: true,
				destroyed: false,
				setTimeout: () => socket,
				on: (event: string, listener: (...args: unknown[]) => void) => {
					listeners.set(event, listener);
					if (event === "connect") queueMicrotask(listener);
					return socket;
				},
				write: (command: string) => {
					if (command === "j/cursorpos") listeners.get("data")?.('{"x":50,"y":25}');
					if (command === "j/monitors") {
						listeners.get("data")?.(
							'[{"x":0,"y":0,"width":100,"height":50,"scale":1,"transform":0}]',
						);
					}
					return true;
				},
				destroy: () => {
					socket.destroyed = true;
				},
			};
			return socket as unknown as net.Socket;
		});

		const tracker = new HyprlandCursorTracker({ sampleIntervalMs: 15, maxSamples: 20 });
		tracker.setCaptureRect({ x: 0, y: 0, width: 100, height: 50 });
		tracker.start();
		await new Promise((resolve) => setTimeout(resolve, 45));
		tracker.rebase();
		await new Promise((resolve) => setTimeout(resolve, 30));
		tracker.pause();
		await new Promise((resolve) => setTimeout(resolve, 80));
		tracker.resume();
		await new Promise((resolve) => setTimeout(resolve, 45));

		const recording = tracker.stop();
		const samples = recording.samples;
		expect(recording.provider).toBe("native");
		expect(samples.length).toBeGreaterThan(1);
		expect(samples[0].timeMs).toBeLessThan(30);
		expect(samples.at(-1)?.timeMs ?? 0).toBeLessThan(110);
		expect(
			samples.every((sample, index) => index === 0 || sample.timeMs >= samples[index - 1].timeMs),
		).toBe(true);
	});
});
