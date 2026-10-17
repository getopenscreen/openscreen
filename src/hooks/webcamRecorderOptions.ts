import { webcamBitrateForStream } from "./webcamCaptureTarget";

/** Keep webcam encoding independent of the screen recorder's codec preference. */
export function webcamRecorderOptions(
	stream: MediaStream | null,
	platform: string,
	isTypeSupported: (mimeType: string) => boolean = (type) => MediaRecorder.isTypeSupported(type),
): MediaRecorderOptions {
	// Chromium's macOS H.264 camera encoder can stop delivering frames while the
	// stream remains live. VP8 avoids that path; native screen capture still uses H.264.
	const codecs = platform === "darwin" ? ["vp8", "vp9", "h264"] : ["h264", "vp8", "vp9"];
	const mimeType = codecs.map((codec) => `video/webm;codecs=${codec}`).find(isTypeSupported);
	return {
		...(mimeType ? { mimeType } : {}),
		videoBitsPerSecond: webcamBitrateForStream(stream),
	};
}
