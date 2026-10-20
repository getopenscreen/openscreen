// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type NativeMicrophonePacket,
	openEchoCancelledMicrophone,
} from "./echoCancelledMicrophone";

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});
const t = (key: string) => `translated:${key}`;

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
	const write = vi.fn<(packet: NativeMicrophonePacket) => Promise<void>>(async () => undefined);
	vi.stubGlobal("electronAPI", { writeNativeMacMicrophone: write });
	return {
		stop,
		write,
		getUserMedia,
		enqueue: (audio: AudioData) => controller.enqueue(audio),
		disconnect: () => controller.close(),
		fail: (error: Error) => controller.error(error),
	};
}

function frame(timestamp: number, overrides: Partial<AudioData> = {}): AudioData {
	return {
		timestamp,
		numberOfFrames: 480,
		numberOfChannels: 1,
		sampleRate: 48_000,
		copyTo: () => undefined,
		close: vi.fn(),
		...overrides,
	} as unknown as AudioData;
}

describe("echo-cancelled microphone", () => {
	it("requests all playback and preserves capture timestamps across the bridge", async () => {
		const mock = capture();
		const microphone = await openEchoCancelledMicrophone(t, "usb-id");
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
		const onWarning = vi.fn();
		microphone.start(7, onError, onWarning);
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
		expect(onWarning).not.toHaveBeenCalled();
	});

	it("refuses a microphone that did not enable system echo cancellation", async () => {
		const mock = capture(true);
		await expect(openEchoCancelledMicrophone(t)).rejects.toThrow(
			t("recording.echoCancellationUnavailable"),
		);
		expect(mock.stop).toHaveBeenCalledOnce();
	});

	it("translates startup failures and logs their diagnostic cause", async () => {
		const mock = capture();
		const cause = new DOMException("Permission denied", "NotAllowedError");
		const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
		mock.getUserMedia.mockRejectedValue(cause);
		await expect(openEchoCancelledMicrophone(t)).rejects.toMatchObject({
			message: t("recording.echoMicrophoneUnavailable"),
		});
		expect(log).toHaveBeenCalledWith(expect.any(String), cause);
		vi.stubGlobal("MediaStreamTrackProcessor", undefined);
		await expect(openEchoCancelledMicrophone(t)).rejects.toThrow(
			t("recording.echoCancellationUnavailable"),
		);
		expect(mock.getUserMedia).toHaveBeenCalledOnce();
	});

	it("reports bridge failure and releases the microphone", async () => {
		const mock = capture();
		const cause = new Error("pipe closed");
		mock.write.mockRejectedValue(cause);
		const microphone = await openEchoCancelledMicrophone(t);
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
		const onWarning = vi.fn();
		microphone.start(7, onError, onWarning);
		await vi.waitFor(() =>
			expect(onError).toHaveBeenCalledWith(
				expect.objectContaining({ message: t("recording.echoMicrophoneWriteFailed") }),
			),
		);
		expect(close).toHaveBeenCalledOnce();
		expect(mock.stop).toHaveBeenCalled();
		expect(onWarning).not.toHaveBeenCalled();
		await microphone.stop();
	});

	it.each([
		"disconnect",
		"read-error",
		"format-change",
	] as const)("warns and releases the microphone after %s without reporting a recorder failure", async (failure) => {
		const mock = capture();
		const microphone = await openEchoCancelledMicrophone(t);
		const onError = vi.fn();
		const onWarning = vi.fn();
		const audio = frame(1, { sampleRate: 44_100 });
		microphone.start(7, onError, onWarning);
		if (failure === "disconnect") mock.disconnect();
		else if (failure === "read-error") mock.fail(new Error("Device lost"));
		else mock.enqueue(audio);
		await vi.waitFor(() =>
			expect(onWarning).toHaveBeenCalledWith(
				expect.objectContaining({ message: t("recording.echoMicrophoneStopped") }),
			),
		);
		expect(onError).not.toHaveBeenCalled();
		expect(mock.stop).toHaveBeenCalled();
		if (failure === "format-change") expect(audio.close).toHaveBeenCalledOnce();
		await microphone.stop();
	});

	it("releases capture without waiting for a stalled recorder write and ignores its late failure", async () => {
		const mock = capture();
		let rejectWrite!: (error: Error) => void;
		mock.write.mockImplementationOnce(
			() =>
				new Promise<void>((_resolve, reject) => {
					rejectWrite = reject;
				}),
		);
		const microphone = await openEchoCancelledMicrophone(t);
		const onError = vi.fn();
		const onWarning = vi.fn();
		microphone.start(7, onError, onWarning);
		mock.enqueue(frame(1));
		await vi.waitFor(() => expect(mock.write).toHaveBeenCalledOnce());
		await microphone.stop();
		expect(mock.stop).toHaveBeenCalled();
		rejectWrite(new Error("late pipe failure"));
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(onError).not.toHaveBeenCalled();
		expect(onWarning).not.toHaveBeenCalled();
		expect(mock.write).toHaveBeenCalledOnce();
	});

	it("closes a frame read just before cancellation without sending it", async () => {
		const mock = capture();
		const microphone = await openEchoCancelledMicrophone(t);
		const audio = frame(1);
		mock.enqueue(audio);
		const onError = vi.fn();
		const onWarning = vi.fn();
		microphone.start(7, onError, onWarning);
		await microphone.stop();
		expect(audio.close).toHaveBeenCalledOnce();
		expect(mock.write).not.toHaveBeenCalled();
		expect(onError).not.toHaveBeenCalled();
		expect(onWarning).not.toHaveBeenCalled();
	});

	it("warns once about missing capture time while preserving timestamps and sequential writes", async () => {
		const mock = capture();
		let release!: () => void;
		mock.write.mockImplementationOnce(() => new Promise<void>((resolve) => (release = resolve)));
		const microphone = await openEchoCancelledMicrophone(t);
		const onError = vi.fn();
		const onWarning = vi.fn();
		microphone.start(7, onError, onWarning);
		for (const timestamp of [100_000, 110_001, 130_000, 160_000]) mock.enqueue(frame(timestamp));
		await vi.waitFor(() => expect(mock.write).toHaveBeenCalledOnce());
		expect(onWarning).not.toHaveBeenCalled();
		release();
		await vi.waitFor(() => expect(mock.write).toHaveBeenCalledTimes(4));
		expect(mock.write.mock.calls.map(([packet]) => packet.timestampUs)).toEqual([
			100_000, 110_001, 130_000, 160_000,
		]);
		expect(onWarning).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({ message: t("recording.echoMicrophoneGap") }),
		);
		expect(onError).not.toHaveBeenCalled();
		await microphone.stop();
	});
});
