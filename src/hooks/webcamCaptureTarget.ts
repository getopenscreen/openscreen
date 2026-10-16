/**
 * The resolution the webcam is captured at, and the rate it is encoded at.
 *
 * Nothing here used to name a size. `getUserMedia({ video: { deviceId } })` and
 * a Media Foundation source reader left without MF_MT_FRAME_SIZE both fall back
 * to the device's *default* media type, and for a UVC camera that is the first
 * format it enumerates -- 640x480. A Logitech BRIO that offers MJPEG up to
 * 3840x2160 was therefore recorded at 640x480 and then scaled up into the
 * picture-in-picture, which is what "the camera looks pixelated" actually was.
 */

export const WEBCAM_TARGET_FRAME_RATE = 30;

export const WEBCAM_QUALITY_IDS = ["1080p", "1440p", "2160p"] as const;
export type WebcamQualityId = (typeof WEBCAM_QUALITY_IDS)[number];

export interface WebcamQualityPreset {
	id: WebcamQualityId;
	width: number;
	height: number;
}

/**
 * Sizes are a *request*, never a floor. A camera that tops out below the chosen
 * preset is driven at the best format it has; the native helper picks that with
 * `chooseWebcamFormat`, and the browser does it through `ideal` constraints.
 *
 * Measured on a BRIO (Snapdragon X, alongside a screen capture), 8s takes,
 * frames the camera actually delivered out of 240, over four runs each:
 *   1080p  244   14.2 Mbit/s   4/4
 *   1440p  242-244  21.9 Mbit/s   4/4
 *   2160p  243-244  38.4 Mbit/s   4/4
 *
 * All three run at the camera's full rate. That is recent: driving the capture
 * as RGB32 made Media Foundation decode and convert every frame, costing 92ms
 * per 2160p frame -- a ceiling near 11 fps, inside a file whose container still
 * claimed 30 because the encoder padded the gap with duplicates. The capture
 * now asks for NV12, which the camera produces directly and the encoder
 * consumes directly; see webcam_capture.cpp. Higher presets cost file size, not
 * frames, which is why this is a user choice.
 */
export const WEBCAM_QUALITY_PRESETS: Record<WebcamQualityId, WebcamQualityPreset> = {
	"1080p": { id: "1080p", width: 1920, height: 1080 },
	"1440p": { id: "1440p", width: 2560, height: 1440 },
	"2160p": { id: "2160p", width: 3840, height: 2160 },
};

export const DEFAULT_WEBCAM_QUALITY: WebcamQualityId = "2160p";

/** Narrows a persisted or IPC-delivered value to a preset we can act on. */
export function webcamQualityFrom(value: unknown): WebcamQualityId {
	return WEBCAM_QUALITY_IDS.includes(value as WebcamQualityId)
		? (value as WebcamQualityId)
		: DEFAULT_WEBCAM_QUALITY;
}

export function webcamPresetFor(quality: WebcamQualityId | undefined): WebcamQualityPreset {
	return WEBCAM_QUALITY_PRESETS[webcamQualityFrom(quality)];
}

/**
 * Video constraints for a webcam stream, optionally pinned to one device.
 *
 * Sizes are `ideal`, never `exact` or `min`: a camera that tops out at 720p has
 * to keep working. `exact` turns "record it a bit smaller" into
 * OverconstrainedError, and the recording then has no camera at all.
 */
export function webcamVideoConstraints(
	deviceId: string | undefined,
	quality?: WebcamQualityId,
): MediaTrackConstraints {
	const preset = webcamPresetFor(quality);
	return {
		...(deviceId ? { deviceId: { exact: deviceId } } : {}),
		width: { ideal: preset.width },
		height: { ideal: preset.height },
		frameRate: { ideal: WEBCAM_TARGET_FRAME_RATE, max: WEBCAM_TARGET_FRAME_RATE },
	};
}

/**
 * Encoder bitrate for a frame the camera actually delivered.
 *
 * Keyed off the delivered size rather than the requested preset: a 720p camera
 * asked for 2160p must not be encoded as if it were 4K. The tiers mirror the
 * native ladder in electron/native/wgc-capture/src/main.cpp -- keep them in step.
 */
export function webcamBitrateFor(width: number | undefined, height: number | undefined): number {
	const preset = WEBCAM_QUALITY_PRESETS[DEFAULT_WEBCAM_QUALITY];
	const pixels =
		width && height && width > 0 && height > 0 ? width * height : preset.width * preset.height;

	if (pixels >= 3840 * 2160) return 40_000_000;
	if (pixels >= 2560 * 1440) return 24_000_000;
	if (pixels >= 1920 * 1080) return 16_000_000;
	if (pixels >= 1280 * 720) return 8_000_000;
	return 4_000_000;
}

/** The bitrate for whatever the stream's first video track ended up delivering. */
export function webcamBitrateForStream(stream: MediaStream | null): number {
	const settings = stream?.getVideoTracks()[0]?.getSettings();
	return webcamBitrateFor(settings?.width, settings?.height);
}
