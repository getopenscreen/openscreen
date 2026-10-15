export type NativeMicrophonePacket = {
	recordingId: number;
	timestampUs: number;
	samples: Float32Array;
};

// Chromium exposes audio here even though the standard's processor is video-only.
type AudioTrackProcessor = new (options: {
	track: MediaStreamTrack;
	maxBufferSize: number;
}) => {
	readable: ReadableStream<AudioData>;
};

export type EchoCancelledMicrophone = {
	start: (recordingId: number, onError: (error: Error) => void) => void;
	stop: () => Promise<void>;
};

export async function openEchoCancelledMicrophone(
	deviceId?: string,
): Promise<EchoCancelledMicrophone> {
	const Processor = (window as unknown as { MediaStreamTrackProcessor?: AudioTrackProcessor })
		.MediaStreamTrackProcessor;
	if (!Processor) throw new Error("Speaker echo cancellation is unavailable in this app version.");
	const stream = await navigator.mediaDevices.getUserMedia({
		audio: {
			...(deviceId && deviceId !== "default" ? { deviceId: { exact: deviceId } } : {}),
			// `true` need not cancel other apps. `all` requests the system loopback reference.
			echoCancellation: { exact: "all" },
			noiseSuppression: false,
			autoGainControl: false,
			channelCount: { exact: 1 },
			sampleRate: { ideal: 48_000 },
		} as unknown as MediaTrackConstraints,
		video: false,
	});
	const track = stream.getAudioTracks()[0];
	let reader: ReadableStreamDefaultReader<AudioData>;
	try {
		const settings = track.getSettings() as Omit<MediaTrackSettings, "echoCancellation"> & {
			echoCancellation?: boolean | string;
		};
		if (settings.echoCancellation !== "all") {
			throw new Error("This microphone cannot cancel speaker echo. Turn off Cancel speaker echo.");
		}
		reader = new Processor({ track, maxBufferSize: 50 }).readable.getReader();
	} catch (error) {
		stream.getTracks().forEach((item) => item.stop());
		throw error;
	}
	let stopped = false;
	let pumping: Promise<void> | undefined;
	const stop = async () => {
		stopped = true;
		try {
			await reader.cancel();
		} catch {
			// An errored stream rejects cancellation too; the pump already reports that error.
		} finally {
			stream.getTracks().forEach((item) => item.stop());
		}
		await pumping;
	};
	return {
		start(recordingId, onError) {
			pumping = (async () => {
				try {
					while (!stopped) {
						const { value: audio, done } = await reader.read();
						if (done) {
							if (!stopped) throw new Error("The echo-cancelled microphone disconnected.");
							break;
						}
						let packet: NativeMicrophonePacket;
						try {
							if (audio.sampleRate !== 48_000 || audio.numberOfChannels !== 1) {
								throw new Error("The echo-cancelled microphone changed audio format.");
							}
							const samples = new Float32Array(audio.numberOfFrames);
							audio.copyTo(samples, { planeIndex: 0, format: "f32-planar" });
							// AudioData retains the host capture timestamp, including AEC delay compensation.
							packet = { recordingId, timestampUs: audio.timestamp, samples };
						} finally {
							audio.close();
						}
						// One outstanding write bounds IPC/pipe backpressure to the processor's queue.
						await window.electronAPI.writeNativeMacMicrophone(packet);
					}
				} catch (error) {
					if (!stopped) onError(error instanceof Error ? error : new Error(String(error)));
				} finally {
					stream.getTracks().forEach((item) => item.stop());
				}
			})();
		},
		stop,
	};
}
