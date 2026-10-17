// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { openEchoCancelledMicrophone } from "./echoCancelledMicrophone";

afterEach(() => vi.unstubAllGlobals());

function capture(mode: string | boolean = "all") {
	let controller!: ReadableStreamDefaultController<AudioData>;
	const stop = vi.fn();
	const track = { stop, getSettings: () => ({ echoCancellation: mode }) };
	const stream = { getAudioTracks: () => [track], getTracks: () => [track] };
	const getUserMedia = vi.fn(async () => stream);
	vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
	vi.stubGlobal(
		"MediaStreamTrackProcessor",
		class {
			readable = new ReadableStream<AudioData>({
				start(c) {
					controller = c;
				},
			});
		},
	);
	const write = vi.fn(async () => undefined);
	vi.stubGlobal("electronAPI", { writeNativeMacMicrophone: write });
	return { stop, write, getUserMedia, enqueue: (audio: AudioData) => controller.enqueue(audio) };
}

describe("echo-cancelled microphone", () => {
	it("requests all playback and preserves capture timestamps across the bridge", async () => {
		const mock = capture();
		const microphone = await openEchoCancelledMicrophone("usb-id");
		const close = vi.fn();
		mock.enqueue({
			timestamp: 123_456_789,
			numberOfFrames: 2,
			numberOfChannels: 1,
			sampleRate: 48_000,
			copyTo: (samples: Float32Array) => samples.set([0.25, -0.5]),
			close,
		} as unknown as AudioData);
		const onError = vi.fn();
		microphone.start(7, onError);
		await vi.waitFor(() => expect(mock.write).toHaveBeenCalledOnce());
		expect(mock.getUserMedia).toHaveBeenCalledWith(
			expect.objectContaining({
				audio: expect.objectContaining({
					deviceId: { exact: "usb-id" },
					echoCancellation: { exact: "all" },
					autoGainControl: false,
				}),
			}),
		);
		expect(mock.write).toHaveBeenCalledWith({
			recordingId: 7,
			timestampUs: 123_456_789,
			samples: new Float32Array([0.25, -0.5]),
		});
		expect(close).toHaveBeenCalledOnce();
		await microphone.stop();
		expect(mock.stop).toHaveBeenCalled();
		expect(onError).not.toHaveBeenCalled();
	});

	it("refuses a microphone that did not enable system echo cancellation", async () => {
		const mock = capture(true);
		await expect(openEchoCancelledMicrophone()).rejects.toThrow("cannot cancel speaker echo");
		expect(mock.stop).toHaveBeenCalledOnce();
	});

	it("reports bridge failure and releases the microphone", async () => {
		const mock = capture();
		mock.write.mockRejectedValue(new Error("pipe closed"));
		const microphone = await openEchoCancelledMicrophone();
		const close = vi.fn();
		mock.enqueue({
			timestamp: 1,
			numberOfFrames: 1,
			numberOfChannels: 1,
			sampleRate: 48_000,
			copyTo: () => undefined,
			close,
		} as unknown as AudioData);
		const onError = vi.fn();
		microphone.start(7, onError);
		await vi.waitFor(() =>
			expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "pipe closed" })),
		);
		expect(close).toHaveBeenCalledOnce();
		expect(mock.stop).toHaveBeenCalled();
		await microphone.stop();
	});
});
