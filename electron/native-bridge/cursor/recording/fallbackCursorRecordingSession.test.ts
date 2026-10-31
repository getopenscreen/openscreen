import { describe, expect, it, vi } from "vitest";
import { FallbackCursorRecordingSession } from "./fallbackCursorRecordingSession";
import type { CursorRecordingSession } from "./session";

function session(
	label: string,
	startImpl: () => Promise<void>,
): CursorRecordingSession & {
	started: boolean;
	stopped: boolean;
} {
	const state = { started: false, stopped: false };
	return {
		get started() {
			return state.started;
		},
		get stopped() {
			return state.stopped;
		},
		start: async () => {
			await startImpl();
			state.started = true;
		},
		stop: async () => {
			state.stopped = true;
			return {
				version: 2,
				provider: "none",
				samples: [
					{
						timeMs: 0,
						cx: 0.5,
						cy: 0.5,
						visible: true,
						interactionType: "move" as const,
					},
				],
				assets: [],
			};
		},
		label,
	} as CursorRecordingSession & { started: boolean; stopped: boolean; label: string };
}

describe("FallbackCursorRecordingSession", () => {
	it("keeps the primary session when it starts", async () => {
		const primary = session("pipewire", async () => undefined);
		const fallback = session("x11", async () => undefined);
		const combined = new FallbackCursorRecordingSession({
			primary,
			createFallback: () => fallback,
		});
		await combined.start();
		const data = await combined.stop();
		expect(primary.started).toBe(true);
		expect(fallback.started).toBe(false);
		expect(primary.stopped).toBe(true);
		expect(data.samples).toHaveLength(1);
	});

	it("starts the fallback when the primary rejects", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const primary = session("pipewire", async () => {
			throw new Error("no METADATA cursor mode");
		});
		const fallback = session("x11", async () => undefined);
		const combined = new FallbackCursorRecordingSession({
			primary,
			createFallback: () => fallback,
		});
		await combined.start();
		await combined.stop();
		expect(primary.started).toBe(false);
		expect(fallback.started).toBe(true);
		expect(fallback.stopped).toBe(true);
	});

	it("surfaces a fallback that also fails", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const primary = session("pipewire", async () => {
			throw new Error("portal down");
		});
		const combined = new FallbackCursorRecordingSession({
			primary,
			createFallback: () =>
				session("x11", async () => {
					throw new Error("no DISPLAY");
				}),
		});
		await expect(combined.start()).rejects.toThrow("no DISPLAY");
	});
});
