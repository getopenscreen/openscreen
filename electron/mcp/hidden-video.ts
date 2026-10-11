// A video decoded by Chromium's own <video> element, in a blank hidden page: its
// duration and size, and still frames of it. No renderer bundle and no ffmpeg
// (the Windows installer ships no ffmpeg executable).

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
