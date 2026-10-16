import { describe, expect, it } from "vitest";
import {
	DEFAULT_WEBCAM_QUALITY,
	WEBCAM_QUALITY_IDS,
	WEBCAM_QUALITY_PRESETS,
	WEBCAM_TARGET_FRAME_RATE,
	webcamBitrateFor,
	webcamBitrateForStream,
	webcamPresetFor,
	webcamQualityFrom,
	webcamVideoConstraints,
} from "./webcamCaptureTarget";

describe("webcamVideoConstraints", () => {
	it("asks for the chosen preset, not the browser's 640x480 default", () => {
		expect(webcamVideoConstraints(undefined, "2160p")).toMatchObject({
			width: { ideal: 3840 },
			height: { ideal: 2160 },
		});
		expect(webcamVideoConstraints(undefined, "1080p")).toMatchObject({
			width: { ideal: 1920 },
			height: { ideal: 1080 },
		});
	});

	it("keeps the size negotiable so a 720p-only camera still opens", () => {
		// `exact` would make getUserMedia throw OverconstrainedError on every
		// camera that cannot hit the target, losing the webcam entirely rather
		// than recording it a little smaller.
		const constraints = webcamVideoConstraints(undefined, "2160p");

		expect(constraints.width).not.toHaveProperty("exact");
		expect(constraints.height).not.toHaveProperty("exact");
		expect(constraints.width).not.toHaveProperty("min");
		expect(constraints.height).not.toHaveProperty("min");
	});

	it("still pins the chosen device and caps the frame rate", () => {
		const constraints = webcamVideoConstraints("camera-7", "1440p");

		expect(constraints.deviceId).toEqual({ exact: "camera-7" });
		expect(constraints.frameRate).toEqual({
			ideal: WEBCAM_TARGET_FRAME_RATE,
			max: WEBCAM_TARGET_FRAME_RATE,
		});
	});

	it("omits deviceId entirely when no camera was chosen", () => {
		expect(webcamVideoConstraints(undefined, "1080p")).not.toHaveProperty("deviceId");
	});

	it("falls back to the default preset rather than an unconstrained request", () => {
		// An unrecognised stored value must not reopen the 640x480 hole.
		expect(webcamVideoConstraints(undefined, undefined)).toEqual(
			webcamVideoConstraints(undefined, DEFAULT_WEBCAM_QUALITY),
		);
	});
});

describe("webcamQualityFrom", () => {
	it("accepts every advertised preset", () => {
		for (const id of WEBCAM_QUALITY_IDS) {
			expect(webcamQualityFrom(id)).toBe(id);
		}
	});

	it("rejects anything else, including settings files from a future build", () => {
		expect(webcamQualityFrom("4320p")).toBe(DEFAULT_WEBCAM_QUALITY);
		expect(webcamQualityFrom(undefined)).toBe(DEFAULT_WEBCAM_QUALITY);
		expect(webcamQualityFrom(null)).toBe(DEFAULT_WEBCAM_QUALITY);
		expect(webcamQualityFrom(1080)).toBe(DEFAULT_WEBCAM_QUALITY);
	});
});

describe("webcamPresetFor", () => {
	it("never returns a size below 1080p", () => {
		for (const id of WEBCAM_QUALITY_IDS) {
			const preset = webcamPresetFor(id);
			expect(preset.width).toBeGreaterThanOrEqual(1920);
			expect(preset.height).toBeGreaterThanOrEqual(1080);
		}
		expect(Object.keys(WEBCAM_QUALITY_PRESETS)).toEqual([...WEBCAM_QUALITY_IDS]);
	});
});

describe("webcamBitrateFor", () => {
	it("scales with the frame the camera actually delivers", () => {
		// A flat rate sized for 640x480 is what made the extra pixels pointless:
		// starve a 2160p frame and it blocks up worse than a clean 1080p one.
		expect(webcamBitrateFor(3840, 2160)).toBeGreaterThan(webcamBitrateFor(2560, 1440));
		expect(webcamBitrateFor(2560, 1440)).toBeGreaterThan(webcamBitrateFor(1920, 1080));
		expect(webcamBitrateFor(1920, 1080)).toBeGreaterThan(webcamBitrateFor(1280, 720));
		expect(webcamBitrateFor(1280, 720)).toBeGreaterThan(webcamBitrateFor(640, 480));
	});

	it("gives 4K enough headroom to be worth capturing", () => {
		expect(webcamBitrateFor(3840, 2160)).toBe(40_000_000);
	});

	it("matches the tier boundaries the native helper uses", () => {
		// One pixel under a tier must not claim that tier's rate; the ladder in
		// wgc-capture/src/main.cpp draws the lines at the same places.
		expect(webcamBitrateFor(2560, 1439)).toBe(webcamBitrateFor(1920, 1080));
		expect(webcamBitrateFor(1920, 1079)).toBe(webcamBitrateFor(1280, 720));
	});

	it("rates a small camera by what it delivered, not by what we asked for", () => {
		// The preset is a request. A 720p camera asked for 2160p must not be
		// handed a 4K bitrate it cannot fill.
		expect(webcamBitrateFor(1280, 720)).toBe(8_000_000);
	});

	it("survives a track that reports nothing", () => {
		// getSettings() may omit width/height before the first frame arrives.
		const preset = WEBCAM_QUALITY_PRESETS[DEFAULT_WEBCAM_QUALITY];
		expect(webcamBitrateFor(undefined, undefined)).toBe(
			webcamBitrateFor(preset.width, preset.height),
		);
		expect(webcamBitrateFor(0, 0)).toBeGreaterThan(0);
	});
});

describe("webcamBitrateForStream", () => {
	const streamWith = (settings: MediaTrackSettings) =>
		({ getVideoTracks: () => [{ getSettings: () => settings }] }) as unknown as MediaStream;

	it("reads the size off the live track", () => {
		expect(webcamBitrateForStream(streamWith({ width: 2560, height: 1440 }))).toBe(24_000_000);
	});

	it("falls back when there is no stream or no video track", () => {
		expect(webcamBitrateForStream(null)).toBe(webcamBitrateFor(undefined, undefined));
		expect(webcamBitrateForStream({ getVideoTracks: () => [] } as unknown as MediaStream)).toBe(
			webcamBitrateFor(undefined, undefined),
		);
	});
});
