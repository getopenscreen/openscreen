// A video decoded by Chromium's own <video> element, in a blank hidden page: its
// duration and size, and still frames of it. A GIF goes through WebCodecs' ImageDecoder
// instead (see openGif). No renderer bundle and no ffmpeg (the Windows installer ships no
// ffmpeg executable).

import { pathToFileURL } from "node:url";
import { BrowserWindow } from "electron";

export interface VideoFrame {
	mimeType: "image/jpeg";
	/** Base64, no data-URL prefix: the shape an MCP image result takes. */
	data: string;
}

export interface OpenedVideo {
	durationSec: number;
	width: number;
	height: number;
	/** The frame shown at `timeSec`, scaled down to at most `maxWidth` pixels wide. */
	capture(timeSec: number, maxWidth: number): Promise<VideoFrame>;
	close(): void;
}

// Each step is bounded: a file Chromium cannot decode may never fire an event,
// and a crashed page never answers.
const STEP_TIMEOUT_MS = 15_000;

function withTimeout<T>(promise: Promise<T>, what: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`Timed out ${what}`)), STEP_TIMEOUT_MS);
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error) => {
				clearTimeout(timer);
				reject(error);
			},
		);
	});
}

export async function openVideoInHiddenWindow(videoPath: string): Promise<OpenedVideo> {
	const win = new BrowserWindow({
		show: false,
		webPreferences: {
			nodeIntegration: false,
			contextIsolation: true,
			// A blank page may not load a file:// video otherwise; same relaxation as the runners.
			webSecurity: false,
			backgroundThrottling: false,
		},
	});
	const close = () => {
		if (!win.isDestroyed()) win.destroy();
	};
	if (isGifPath(videoPath)) return openGif(win, videoPath, close);
	try {
		await win.loadURL("about:blank");
		const meta = (await withTimeout(
			win.webContents.executeJavaScript(`new Promise((resolve, reject) => {
				const video = document.createElement("video");
				video.muted = true;
				video.preload = "auto";
				video.onloadeddata = () =>
					resolve({ durationSec: video.duration, width: video.videoWidth, height: video.videoHeight });
				video.onerror = () =>
					reject(new Error("Chromium could not decode the video (media error " + (video.error && video.error.code) + ")"));
				window.__video = video;
				video.src = ${JSON.stringify(pathToFileURL(videoPath).href)};
			})`),
			"loading the video",
		)) as { durationSec: number; width: number; height: number };

		return {
			...meta,
			close,
			async capture(timeSec, maxWidth) {
				const dataUrl = (await withTimeout(
					win.webContents.executeJavaScript(`new Promise((resolve) => {
						const video = window.__video;
						const draw = () => {
							const scale = Math.min(1, ${maxWidth} / video.videoWidth);
							const canvas = document.createElement("canvas");
							canvas.width = Math.round(video.videoWidth * scale);
							canvas.height = Math.round(video.videoHeight * scale);
							canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
							resolve(canvas.toDataURL("image/jpeg", 0.85));
						};
						// A seek to where the video already is may never fire "seeked".
						if (Math.abs(video.currentTime - ${timeSec}) < 1e-3 && video.readyState >= 2) {
							draw();
						} else {
							video.onseeked = draw;
							video.currentTime = ${timeSec};
						}
					})`),
					`seeking to ${timeSec}s`,
				)) as string;
				return { mimeType: "image/jpeg", data: dataUrl.slice(dataUrl.indexOf(",") + 1) };
			},
		};
	} catch (error) {
		close();
		throw error;
	}
}

export function isGifPath(path: string): boolean {
	return path.toLowerCase().endsWith(".gif");
}

/** The frame on screen at `timeSec`, from each frame's start time in seconds (ascending, from 0). */
export function gifFrameIndexAt(frameStartsSec: readonly number[], timeSec: number): number {
	let index = 0;
	for (let i = 1; i < frameStartsSec.length && frameStartsSec[i] <= timeSec; i++) index = i;
	return index;
}

// Chromium's <video> does not play a GIF, so a GIF export is decoded with WebCodecs'
// ImageDecoder instead. That API needs a secure context, which about:blank is not, so the
// page is the GIF itself: a file:// page is secure, and fetching its own URL is same-origin.
async function openGif(
	win: BrowserWindow,
	gifPath: string,
	close: () => void,
): Promise<OpenedVideo> {
	try {
		const url = pathToFileURL(gifPath).href;
		await win.loadURL(url);
		const meta = (await withTimeout(
			win.webContents.executeJavaScript(`(async () => {
				if (typeof ImageDecoder === "undefined") throw new Error("Chromium cannot decode a GIF here (no ImageDecoder)");
				const response = await fetch(${JSON.stringify(url)});
				const decoder = new ImageDecoder({ data: response.body, type: "image/gif" });
				await decoder.tracks.ready;
				await decoder.completed;
				const frameCount = decoder.tracks.selectedTrack.frameCount;
				// Frame durations come with the decoded frames only, so every frame is decoded once.
				const frameStartsSec = [];
				let t = 0;
				let width = 0;
				let height = 0;
				for (let i = 0; i < frameCount; i++) {
					const { image } = await decoder.decode({ frameIndex: i });
					frameStartsSec.push(t);
					t += (image.duration ?? 0) / 1e6;
					width = image.displayWidth;
					height = image.displayHeight;
					image.close();
				}
				window.__gif = decoder;
				return { durationSec: t, width, height, frameStartsSec };
			})()`),
			"loading the GIF",
		)) as { durationSec: number; width: number; height: number; frameStartsSec: number[] };
		const { frameStartsSec, ...size } = meta;

		return {
			...size,
			close,
			async capture(timeSec, maxWidth) {
				const frameIndex = gifFrameIndexAt(frameStartsSec, timeSec);
				const dataUrl = (await withTimeout(
					win.webContents.executeJavaScript(`(async () => {
						const { image } = await window.__gif.decode({ frameIndex: ${frameIndex} });
						const scale = Math.min(1, ${maxWidth} / image.displayWidth);
						const canvas = document.createElement("canvas");
						canvas.width = Math.round(image.displayWidth * scale);
						canvas.height = Math.round(image.displayHeight * scale);
						canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
						image.close();
						return canvas.toDataURL("image/jpeg", 0.85);
					})()`),
					`decoding the GIF at ${timeSec}s`,
				)) as string;
				return { mimeType: "image/jpeg", data: dataUrl.slice(dataUrl.indexOf(",") + 1) };
			},
		};
	} catch (error) {
		close();
		throw error;
	}
}
