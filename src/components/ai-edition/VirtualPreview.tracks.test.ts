import { describe, expect, it } from "vitest";
import { dropVideoTrack } from "./VirtualPreview";

/** A media element as Chromium shows it under `AudioVideoTracks`: track lists, nothing else. */
function element(tracks: { audio?: number; video?: number }) {
	const videoTracks = Array.from({ length: tracks.video ?? 0 }, (_, index) => ({
		selected: index === 0,
	}));
	return {
		element: {
			audioTracks: tracks.audio === undefined ? undefined : { length: tracks.audio },
			videoTracks: tracks.video === undefined ? undefined : videoTracks,
		} as unknown as HTMLMediaElement,
		videoTracks,
	};
}

describe("dropVideoTrack", () => {
	it("deselects the picture of an element that has sound to keep time with", () => {
		const { element: media, videoTracks } = element({ audio: 1, video: 1 });

		expect(dropVideoTrack(media)).toBe(true);
		expect(videoTracks[0].selected).toBe(false);
	});

	// With neither track selected an element has no stream left to keep time with: measured,
	// its clock races to the end instead of playing.
	it("leaves a recording without sound decoding, so its clock still runs", () => {
		const { element: media, videoTracks } = element({ audio: 0, video: 1 });

		expect(dropVideoTrack(media)).toBe(false);
		expect(videoTracks[0].selected).toBe(true);
	});

	it("does nothing where the track lists are absent (the Blink feature is off)", () => {
		const { element: media } = element({});

		expect(dropVideoTrack(media)).toBe(false);
	});

	it("does nothing to an element with no picture, the extracted second audio track", () => {
		const { element: media } = element({ audio: 1, video: 0 });

		expect(dropVideoTrack(media)).toBe(false);
	});
});
