import { describe, expect, it } from "vitest";
import twoTrackVideoUrl from "../../../tests/fixtures/two-audio-tracks.mp4?url";
import { VideoExporter } from "./videoExporter";

describe("multi-track audio export (real browser)", () => {
	// The fixture carries two audio tracks: a silent first track and a 440Hz
	// tone second track — the shape the native capture helpers produce (system
	// audio + microphone). Reading only the demuxer's default track exports
	// pure silence (#silent-export regression).
	it("mixes every audio track instead of exporting only the first", async () => {
		const exporter = new VideoExporter({
			videoUrl: twoTrackVideoUrl,
			width: 320,
			height: 180,
			frameRate: 15,
			bitrate: 1_000_000,
			wallpaper: "#1a1a2e",
			// A zoom region forces the re-encode path; the source-copy fast path
			// returns the source verbatim and never touches AudioProcessor.
			zoomRegions: [
				{
					id: "zoom-1",
					startMs: 500,
					endMs: 1500,
					depth: 3,
					customScale: 1.5,
					focus: { cx: 0.5, cy: 0.5 },
					source: "auto" as const,
				},
			],
			showShadow: false,
			shadowIntensity: 0,
			showBlur: false,
			cropRegion: { x: 0, y: 0, width: 1, height: 1 },
		});

		const result = await exporter.export();
		expect(result.success, result.error).toBe(true);

		const audioContext = new AudioContext();
		try {
			const decoded = await audioContext.decodeAudioData(await result.blob!.arrayBuffer());
			let peak = 0;
			for (let channel = 0; channel < decoded.numberOfChannels; channel++) {
				const samples = decoded.getChannelData(channel);
				for (let i = 0; i < samples.length; i++) {
					peak = Math.max(peak, Math.abs(samples[i]));
				}
			}
			expect(peak).toBeGreaterThan(0.1);
		} finally {
			await audioContext.close();
		}
	});
});
