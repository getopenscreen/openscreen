// The media tools' pixel work, done by Electron's own image codec: no window, no canvas and no
// dependency. Both servers hand this to the tools (media-tools.ts), which import no `electron`.

import { nativeImage } from "electron";
import { type FrameImages, regionRect } from "./contact-sheet";

/** What the addon and the hidden video window encode their frames at. */
const JPEG_QUALITY = 85;

function decoded(jpeg: Buffer): Electron.NativeImage {
	const image = nativeImage.createFromBuffer(jpeg);
	if (image.isEmpty()) throw new Error("a frame is not a picture this build can decode");
	return image;
}

/** No wider than `maxWidth`: scaled down, never up. */
function fitted(image: Electron.NativeImage, maxWidth: number): Electron.NativeImage {
	return image.getSize().width > maxWidth
		? image.resize({ width: Math.max(1, Math.round(maxWidth)), quality: "best" })
		: image;
}

export const frameImages: FrameImages = {
	decode(jpeg, maxWidth) {
		const image = fitted(decoded(jpeg), maxWidth);
		return { ...image.getSize(), pixels: image.toBitmap() };
	},
	encode({ width, height, pixels }) {
		return nativeImage.createFromBitmap(pixels, { width, height }).toJPEG(JPEG_QUALITY);
	},
	crop(jpeg, region, maxWidth) {
		const image = decoded(jpeg);
		const { width, height } = image.getSize();
		return fitted(image.crop(regionRect(width, height, region)), maxWidth).toJPEG(JPEG_QUALITY);
	},
};
