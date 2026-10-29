import fs from "node:fs/promises";
import path from "node:path";
import { nativeImage } from "electron";

/** Read the native camera's atomic latest-frame mailbox, with no queued reads. */
export function watchWindowsCameraPreview(
	file: string,
	onFrame: (jpeg: string, aspectRatio: number) => void,
) {
	let cancelled = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const read = async () => {
		try {
			const data = await fs.readFile(file);
			if (cancelled || data.length > 3_300_000) return;
			if (data.length < 54 || data.toString("ascii", 0, 2) !== "BM") return;
			const width = data.readInt32LE(18);
			const height = -data.readInt32LE(22);
			if (
				width < 1 ||
				width > 320 ||
				height < 1 ||
				height > 2560 ||
				data.length !== 54 + width * height * 4
			)
				return;
			const image = nativeImage.createFromBitmap(data.subarray(54), { width, height });
			if (!image.isEmpty() && width > 0 && height > 0) {
				onFrame(`data:image/jpeg;base64,${image.toJPEG(70).toString("base64")}`, width / height);
			}
		} catch {
			// No first frame yet, or Windows still has the replaced file open.
		} finally {
			if (!cancelled) timer = setTimeout(() => void read(), 200);
		}
	};
	void read();
	return () => {
		cancelled = true;
		clearTimeout(timer);
	};
}

/** A private per-take directory also lets cleanup remove a half-written frame. */
export async function createWindowsCameraPreviewMailbox(tempDir: string) {
	const directory = await fs.mkdtemp(path.join(tempDir, "openscreen-camera-preview-"));
	return {
		file: path.join(directory, "latest.bmp"),
		remove: () =>
			fs.rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }),
	};
}
