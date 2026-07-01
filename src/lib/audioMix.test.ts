import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MIC_FADE_IN_S, MIC_GAIN_BOOST, mixAudioTracks } from "./audioMix";

class FakeAudioParam {
	value = 1;
	setValueAtTime = vi.fn((v: number) => {
		this.value = v;
	});
	linearRampToValueAtTime = vi.fn((v: number) => {
		this.value = v;
	});
}

class FakeGainNode {
	gain = new FakeAudioParam();
	// Real AudioNode.connect returns the destination so it can be chained.
	connect = vi.fn(<T>(destination: T) => destination);
}

class FakeMediaStreamAudioSourceNode {
	connect = vi.fn(<T>(destination: T) => destination);
}

class FakeAudioContext {
	currentTime = 0.5;
	destination: FakeMediaStreamDestination;
	createGain = vi.fn(() => new FakeGainNode());
	createMediaStreamSource = vi.fn(() => new FakeMediaStreamAudioSourceNode());
	createMediaStreamDestination = vi.fn(() => new FakeMediaStreamDestination());
	close = vi.fn();
	constructor() {
		this.destination = new FakeMediaStreamDestination();
	}
}

class FakeMediaStreamDestination {
	stream = { getAudioTracks: () => [{ kind: "audio", id: "dest-track" }] };
	connect = vi.fn(<T>(destination: T) => destination);
}

const stubAudioContext = (currentTime = 0.5): FakeAudioContext => {
	const instance = new FakeAudioContext();
	instance.currentTime = currentTime;
	// Returning a non-this object from a constructor replaces the constructed
	// instance, so every `new AudioContext()` yields the same spy bundle.
	class StubAudioContext {
		constructor() {
			return instance as unknown as StubAudioContext;
		}
	}
	vi.stubGlobal("AudioContext", StubAudioContext);
	return instance;
};

const stubMediaStream = () => {
	class FakeMediaStream {
		tracks: MediaStreamTrack[];
		constructor(tracks: MediaStreamTrack[]) {
			this.tracks = tracks;
		}
	}
	vi.stubGlobal("MediaStream", FakeMediaStream);
};

const track = (id: string) => ({ kind: "audio", id }) as unknown as MediaStreamTrack;

describe("mixAudioTracks", () => {
	beforeEach(() => {
		stubMediaStream();
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("returns the system track verbatim and no context when only system audio is present", () => {
		const system = track("sys");
		const result = mixAudioTracks({ systemAudioTrack: system, micAudioTrack: null });
		expect(result.context).toBeNull();
		expect(result.track).toBe(system);
	});

	it("returns the mic track verbatim and no context when only mic is present", () => {
		const mic = track("mic");
		const result = mixAudioTracks({ systemAudioTrack: null, micAudioTrack: mic });
		expect(result.context).toBeNull();
		expect(result.track).toBe(mic);
	});

	it("returns null track and no context when neither track is present", () => {
		const result = mixAudioTracks({ systemAudioTrack: null, micAudioTrack: null });
		expect(result.context).toBeNull();
		expect(result.track).toBeNull();
	});

	it("creates an AudioContext, fades the mic gain from 0 to MIC_GAIN_BOOST over MIC_FADE_IN_S, and returns the destination track when both inputs are present", () => {
		const fakeCtx = stubAudioContext(0.5);

		const system = track("sys");
		const mic = track("mic");
		const result = mixAudioTracks({ systemAudioTrack: system, micAudioTrack: mic });

		expect(result.context).toBe(fakeCtx);
		expect(fakeCtx.createGain).toHaveBeenCalledTimes(1);
		expect(fakeCtx.createMediaStreamSource).toHaveBeenCalledTimes(2);
		expect(fakeCtx.createMediaStreamDestination).toHaveBeenCalledTimes(1);

		const [gain] = fakeCtx.createGain.mock.results.map((r) => r.value) as FakeGainNode[];
		expect(gain.gain.setValueAtTime).toHaveBeenCalledWith(0, 0.5);
		expect(gain.gain.linearRampToValueAtTime).toHaveBeenCalledWith(
			MIC_GAIN_BOOST,
			0.5 + MIC_FADE_IN_S,
		);

		const [systemSource, micSource] = fakeCtx.createMediaStreamSource.mock.results.map(
			(r) => r.value,
		) as FakeMediaStreamAudioSourceNode[];
		const [destination] = fakeCtx.createMediaStreamDestination.mock.results.map(
			(r) => r.value,
		) as FakeMediaStreamDestination[];
		expect(systemSource.connect).toHaveBeenCalledWith(destination);
		expect(micSource.connect).toHaveBeenCalledWith(gain);
		expect(gain.connect).toHaveBeenCalledWith(destination);

		expect(result.track).toEqual({ kind: "audio", id: "dest-track" });
	});

	it("honors AudioContext.currentTime=0 so the fade-in starts at the very first audio packet", () => {
		const fakeCtx = stubAudioContext(0);
		const result = mixAudioTracks({ systemAudioTrack: track("sys"), micAudioTrack: track("mic") });
		const [gain] = fakeCtx.createGain.mock.results.map((r) => r.value) as FakeGainNode[];
		expect(gain.gain.setValueAtTime).toHaveBeenCalledWith(0, 0);
		expect(gain.gain.linearRampToValueAtTime).toHaveBeenCalledWith(MIC_GAIN_BOOST, MIC_FADE_IN_S);
		expect(result.context).toBe(fakeCtx);
	});
});
