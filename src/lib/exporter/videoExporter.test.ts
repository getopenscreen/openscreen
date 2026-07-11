import { describe, expect, it, vi } from "vitest";
import {
	getSourceCopyFastPathBlockers,
	isSourceCopyFastPathEligible,
	type VideoExporterConfig,
	waitForEncoderQueueSpace,
} from "./videoExporter";

function createConfig(overrides: Partial<VideoExporterConfig> = {}): VideoExporterConfig {
	return {
		videoUrl: "recording.mp4",
		width: 1920,
		height: 1080,
		frameRate: 60,
		bitrate: 30_000_000,
		wallpaper: "#000000",
		zoomRegions: [],
		trimRegions: [],
		speedRegions: [],
		showShadow: false,
		shadowIntensity: 0,
		showBlur: false,
		cropRegion: { x: 0, y: 0, width: 1, height: 1 },
		...overrides,
	};
}

describe("isSourceCopyFastPathEligible", () => {
	it("allows a no-op MP4 export at source dimensions", () => {
		expect(
			isSourceCopyFastPathEligible(createConfig(), {
				width: 1920,
				height: 1080,
			}),
		).toBe(true);
	});

	it("rejects timeline edits and frame-level effects", () => {
		const videoInfo = { width: 1920, height: 1080 };

		expect(
			isSourceCopyFastPathEligible(
				createConfig({ trimRegions: [{ id: "trim", startMs: 100, endMs: 200 }] }),
				videoInfo,
			),
		).toBe(false);
		expect(
			isSourceCopyFastPathEligible(
				createConfig({
					speedRegions: [{ id: "speed", startMs: 100, endMs: 200, speed: 1.5 }],
				}),
				videoInfo,
			),
		).toBe(false);
		// A 100× region must also block the copy path (any non-1× speed does), so its
		// audio is re-rendered (offline time-stretch) rather than passed through untouched.
		expect(
			isSourceCopyFastPathEligible(
				createConfig({
					speedRegions: [{ id: "speed", startMs: 100, endMs: 200, speed: 100 }],
				}),
				videoInfo,
			),
		).toBe(false);
		expect(
			isSourceCopyFastPathEligible(
				createConfig({
					zoomRegions: [
						{
							id: "zoom",
							startMs: 100,
							endMs: 200,
							depth: 2,
							focus: { cx: 0.5, cy: 0.5 },
						},
					],
				}),
				videoInfo,
			),
		).toBe(false);
		expect(isSourceCopyFastPathEligible(createConfig({ showBlur: true }), videoInfo)).toBe(false);
	});

	it("rejects resizing and overlays", () => {
		const videoInfo = { width: 1920, height: 1080 };

		expect(isSourceCopyFastPathEligible(createConfig({ width: 1280 }), videoInfo)).toBe(false);
		expect(
			isSourceCopyFastPathEligible(
				createConfig({
					cursorScale: 2,
				}),
				videoInfo,
			),
		).toBe(false);
		expect(
			isSourceCopyFastPathEligible(
				createConfig({
					cursorScale: 2,
					cursorRecordingData: {
						version: 2,
						provider: "native",
						assets: [
							{
								id: "cursor",
								platform: "win32",
								imageDataUrl: "data:image/png;base64,AA==",
								width: 32,
								height: 32,
								hotspotX: 0,
								hotspotY: 0,
							},
						],
						samples: [{ timeMs: 0, cx: 0.5, cy: 0.5, visible: true, assetId: "cursor" }],
					},
				}),
				videoInfo,
			),
		).toBe(false);
	});
});

describe("getSourceCopyFastPathBlockers", () => {
	it("reports the source-size mismatch that blocks copy-only export", () => {
		expect(
			getSourceCopyFastPathBlockers(createConfig({ height: 1080 }), {
				width: 1920,
				height: 1032,
			}),
		).toContain("output-size 1920x1080 differs from source 1920x1032");
	});
});

// The original bug measured the timeout from the encoder's last *output* event
// (lastEncoderOutputAt), which went stale while the decoder discarded frames inside
// a trim region. waitForEncoderQueueSpace fixes this by starting the clock fresh on
// each call instead of accepting any such external timestamp — by construction, there
// is no "last output" state to go stale, so that regression can't be reintroduced
// without changing this function's signature.
describe("waitForEncoderQueueSpace", () => {
	function fakeClock(start = 0) {
		let elapsedMs = start;
		return {
			now: () => elapsedMs,
			sleep: async (ms: number) => {
				elapsedMs += ms;
			},
		};
	}

	it("resolves immediately when the queue already has space", async () => {
		const clock = fakeClock();
		const sleep = vi.fn(clock.sleep);

		await waitForEncoderQueueSpace({
			getQueueSize: () => 0,
			maxEncodeQueue: 8,
			isCancelled: () => false,
			encoderPreference: "prefer-hardware",
			now: clock.now,
			sleep,
		});

		expect(sleep).not.toHaveBeenCalled();
	});

	it("waits for the queue to drain and then resolves", async () => {
		const clock = fakeClock();
		let queueSize = 8;
		// Queue drains well within the timeout.
		const sleep = vi.fn(async (ms: number) => {
			await clock.sleep(ms);
			queueSize = 0;
		});

		await waitForEncoderQueueSpace({
			getQueueSize: () => queueSize,
			maxEncodeQueue: 8,
			isCancelled: () => false,
			encoderPreference: "prefer-hardware",
			now: clock.now,
			sleep,
		});

		expect(sleep).toHaveBeenCalledTimes(1);
	});

	it("throws a hardware-specific error once the queue stays full past the timeout", async () => {
		const clock = fakeClock();

		await expect(
			waitForEncoderQueueSpace({
				getQueueSize: () => 8,
				maxEncodeQueue: 8,
				isCancelled: () => false,
				encoderPreference: "prefer-hardware",
				now: clock.now,
				sleep: clock.sleep,
			}),
		).rejects.toThrow(
			"The hardware video encoder stopped responding. Retrying with a safer encoder.",
		);
	});

	it("throws a generic error for the software encoder once the queue stays full past the timeout", async () => {
		const clock = fakeClock();

		await expect(
			waitForEncoderQueueSpace({
				getQueueSize: () => 8,
				maxEncodeQueue: 8,
				isCancelled: () => false,
				encoderPreference: "prefer-software",
				now: clock.now,
				sleep: clock.sleep,
			}),
		).rejects.toThrow("The video encoder stopped responding during export.");
	});

	it("stops waiting without throwing once cancelled", async () => {
		const clock = fakeClock();
		let cancelled = false;
		const sleep = vi.fn(async (ms: number) => {
			await clock.sleep(ms);
			cancelled = true;
		});

		await expect(
			waitForEncoderQueueSpace({
				getQueueSize: () => 8,
				maxEncodeQueue: 8,
				isCancelled: () => cancelled,
				encoderPreference: "prefer-hardware",
				now: clock.now,
				sleep,
			}),
		).resolves.toBeUndefined();
	});
});
