// Builds the two benchmark projects (schema 8, readable by v2.0.0 and main) and the cursor sidecar.
// usage: node gen-projects.mjs <mediaDir> <outDir>
//
// The media first, in <mediaDir>:
//   ffmpeg -f lavfi -i "color=c=0x303030:s=1920x1080:r=60:d=60" -f lavfi -i "color=c=white:s=8x80:r=60:d=60"
//     -f lavfi -i "sine=f=440:d=60,volume=-30dB"
//     -filter_complex "[0:v]noise=alls=12:allf=t[bg];[bg][1:v]overlay=x='mod(n*16\,1920)':y=40[v]"
//     -map "[v]" -map 2:a -c:v libx264 -preset fast -profile:v high -pix_fmt yuv420p
//     -b:v 14M -maxrate 16M -bufsize 28M -g 120 -c:a aac -b:a 128k screen.mp4
//   ffmpeg -f lavfi -i "testsrc2=s=1920x1080:r=30:d=60" -vf "noise=alls=10:allf=t" -c:v libx264
//     -preset fast -profile:v high -pix_fmt yuv420p -b:v 16M -maxrate 18M -bufsize 32M -g 60 webcam.mp4
//   ffmpeg -f lavfi -i "sine=f=220:d=60" -f lavfi -i "sine=f=330:d=60"
//     -filter_complex "amix=inputs=2,volume=0.5" -c:a libmp3lame -b:a 128k music.mp3
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const [mediaDir, outDir] = process.argv.slice(2).map((p) => path.resolve(p));
fs.mkdirSync(outDir, { recursive: true });
const DUR = 60;
const screen = path.join(mediaDir, "screen.mp4");
const webcam = path.join(mediaDir, "webcam.mp4");
const music = path.join(mediaDir, "music.mp3");
// All three before writing anything: a heavy project whose camera track points at nothing would
// benchmark something else than PiP.
for (const file of [screen, webcam, music]) {
	if (!fs.existsSync(file))
		throw new Error(`missing ${file}: generate the media first (see above)`);
}
const now = "2026-10-15T15:00:00.000Z";

// Cursor: horizontal triangle sweep 0.15 -> 0.85 -> 0.15, 4 s period, y fixed, sampled every 8 ms.
// Constant speed between turns, so any jitter in the preview is a timing error, not the input.
const samples = [];
for (let t = 0; t <= DUR * 1000; t += 8) {
	const phase = (t % 4000) / 2000; // 0..2
	const u = phase <= 1 ? phase : 2 - phase;
	samples.push({
		timeMs: t,
		cx: 0.15 + 0.7 * u,
		cy: 0.62,
		visible: true,
		cursorType: "arrow",
		interactionType: "move",
	});
}
fs.writeFileSync(
	`${screen}.cursor.json`,
	JSON.stringify({ version: 2, provider: "native", samples, assets: [] }),
);

const id = (p) => `${p}_${randomUUID()}`;
const anchor = (clipId, a, b) => ({
	clipId,
	sourceStartSec: a,
	sourceEndSec: b,
	startMs: a * 1000,
	endMs: b * 1000,
});

function baseDoc(title, withCamera) {
	const assetId = id("asset");
	const clipId = id("clip");
	return {
		assetId,
		clipId,
		doc: {
			schemaVersion: 8,
			project: { id: id("proj"), title, createdAt: now, updatedAt: now, primaryAssetId: assetId },
			assets: [
				{
					id: assetId,
					kind: "video",
					label: "screen.mp4",
					originalPath: screen,
					durationSec: DUR,
					sizeBytes: fs.statSync(screen).size,
					video: { codec: "h264", width: 1920, height: 1080, fps: 60 },
					cameraTrack: withCamera
						? {
								sourcePath: webcam,
								startMs: 0,
								offsetMs: 0,
								visible: true,
								width: 1920,
								height: 1080,
							}
						: null,
				},
			],
			transcript: null,
			transcripts: [],
			timeline: {
				clips: [
					{
						id: clipId,
						assetId,
						sourceStartSec: 0,
						sourceEndSec: DUR,
						timelineStartSec: 0,
						timelineEndSec: DUR,
						wordRefs: [],
						origin: "user",
						reason: "bench",
					},
				],
				gaps: [],
				trimRanges: [],
				muteRanges: [],
				speedRanges: [],
				captionRanges: [],
			},
			annotations: [],
			zoomRanges: [],
			audioTracks: [],
			legacyEditor: null,
		},
	};
}

// Light: one take, one zoom, plain dark wallpaper, no cursor motion blur (keeps the cursor detectable).
{
	const { doc, clipId } = baseDoc("bench-light", false);
	doc.zoomRanges.push({
		id: id("zoom"),
		...anchor(clipId, 20, 26),
		depth: 2,
		focus: { cx: 0.5, cy: 0.5 },
		focusMode: "manual",
		source: "manual",
	});
	doc.legacyEditor = {
		aspectRatio: "16:9",
		wallpaper: "#101010",
		padding: 10,
		borderRadius: 0,
		shadowIntensity: 0,
		motionBlurAmount: 0,
		autoZoomEnabled: false,
		cursorSize: 1.5,
		cursorSmoothing: 0.5,
		cursorMotionBlur: 0,
		cursorClickBounce: 0,
		webcamLayoutPreset: "no-webcam",
	};
	fs.writeFileSync(path.join(outDir, `${doc.project.id}.openscreen`), JSON.stringify(doc, null, 1));
	console.log("light", doc.project.id);
}

// Heavy: webcam PiP, five zooms (three 3D), text + arrow + blur annotations, captions on, a music bed.
{
	const { doc, clipId, assetId } = baseDoc("bench-heavy", true);
	const z = (a, b, depth, extra) => ({
		id: id("zoom"),
		...anchor(clipId, a, b),
		depth,
		focus: { cx: 0.5, cy: 0.5 },
		focusMode: "manual",
		source: "manual",
		...extra,
	});
	doc.zoomRanges.push(
		z(4, 9, 2, { focus: { cx: 0.3, cy: 0.4 } }),
		z(12, 17, 3, { rotationPreset: "orbit" }),
		z(22, 27, 2, { rotationPreset: "left", focus: { cx: 0.7, cy: 0.6 } }),
		z(35, 41, 4, { focusMode: "auto" }),
		z(48, 53, 2, { rotationPreset: "right" }),
	);
	const style = {
		color: "#ffffff",
		backgroundColor: "rgba(0, 0, 0, 0.7)",
		fontSize: 40,
		fontFamily: "Inter",
		fontWeight: "bold",
		fontStyle: "normal",
		textDecoration: "none",
		textAlign: "center",
		textAnimation: "fade",
	};
	doc.annotations.push(
		{
			id: id("ann"),
			...anchor(clipId, 2, 11),
			type: "text",
			content: "Benchmark title",
			textContent: "Benchmark title",
			space: "frame",
			position: { x: 30, y: 8 },
			size: { width: 40, height: 10 },
			style,
			zIndex: 1,
		},
		{
			id: id("ann"),
			...anchor(clipId, 18, 30),
			type: "figure",
			content: "",
			space: "frame",
			position: { x: 60, y: 30 },
			size: { width: 12, height: 20 },
			style,
			zIndex: 2,
			figureData: { arrowDirection: "down-left", color: "#34B27B", strokeWidth: 14 },
		},
		{
			id: id("ann"),
			...anchor(clipId, 30, 45),
			type: "blur",
			content: "",
			position: { x: 10, y: 60 },
			size: { width: 25, height: 20 },
			style,
			zIndex: 3,
			blurData: { type: "blur", shape: "rectangle", color: "white", intensity: 12, blockSize: 12 },
		},
	);
	// Transcript: one word every 0.5 s, eight words per segment, so captions change twice a second.
	const words = [];
	const segments = [];
	for (let s = 0; s < DUR / 4; s++) {
		const segId = `seg_${s}`;
		const ids = [];
		for (let w = 0; w < 8; w++) {
			const t = s * 4 + w * 0.5;
			const wid = `w_${s}_${w}`;
			ids.push(wid);
			words.push({
				id: wid,
				segmentId: segId,
				startSec: t,
				endSec: t + 0.45,
				text: `word${s * 8 + w}`,
			});
		}
		segments.push({
			id: segId,
			kind: "speech",
			startSec: s * 4,
			endSec: s * 4 + 3.95,
			text: ids.map((_, w) => `word${s * 8 + w}`).join(" "),
			wordIds: ids,
		});
	}
	doc.transcript = { assetId, language: "en", segments, words };
	doc.transcripts = [doc.transcript];
	const musicId = id("asset");
	doc.assets.push({
		id: musicId,
		kind: "audio",
		label: "music.mp3",
		originalPath: music,
		durationSec: DUR,
		sizeBytes: fs.statSync(music).size,
		cameraTrack: null,
	});
	const trackId = id("audio");
	doc.audioTracks.push({
		id: trackId,
		trackId,
		...anchor(clipId, 0, DUR),
		assetId: musicId,
		kind: "music",
		durationSec: DUR,
		offsetMs: 0,
		gainDb: -18,
		loop: false,
		fadeInMs: 1000,
		fadeOutMs: 1000,
		muted: false,
		label: "music.mp3",
		origin: "user",
	});
	doc.legacyEditor = {
		aspectRatio: "16:9",
		wallpaper: "/wallpapers/wallpaper15.jpg",
		wallpaperMotion: "drift",
		frame: "none",
		shadowIntensity: 0.6,
		backgroundBlur: 0.26,
		motionBlurAmount: 0.2,
		depthOfField: true,
		borderRadius: 40,
		padding: 50,
		autoZoomEnabled: false,
		webcamLayoutPreset: "picture-in-picture",
		webcamMaskShape: "square",
		webcamRoundness: 0.7,
		webcamMirrored: false,
		webcamReactiveZoom: true,
		webcamSizePreset: 40,
		cursorSize: 2.25,
		cursorSmoothing: 0.67,
		cursorMotionBlur: 0.35,
		cursorClickBounce: 1,
		captions: {
			enabled: true,
			captionLane: "recording",
			fontSize: 48,
			fontFamily: "Inter",
			fontWeight: "bold",
			color: "#ffffff",
			backgroundEnabled: true,
			backgroundOpacity: 0.55,
			backgroundColor: "#000000",
			anchorV: "bottom",
			insetY: 1.5,
			anchorH: "center",
			insetX: 10,
			minWordsPerLine: 2,
			maxWordsPerLine: 7,
		},
	};
	fs.writeFileSync(path.join(outDir, `${doc.project.id}.openscreen`), JSON.stringify(doc, null, 1));
	console.log("heavy", doc.project.id);
}
