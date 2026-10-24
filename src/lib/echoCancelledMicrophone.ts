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
	start: (
		recordingId: number,
		onError: (error: Error) => void,
		onWarning: (warning: Error) => void,
	) => void;
	stop: () => Promise<void>;
};

export async function openEchoCancelledMicrophone(
	t: (key: string) => string,
	deviceId?: string,
): Promise<EchoCancelledMicrophone> {
	const Processor = (window as unknown as { MediaStreamTrackProcessor?: AudioTrackProcessor })
		.MediaStreamTrackProcessor;
	if (!Processor) throw new Error(t("recording.echoCancellationUnavailable"));
	const stream = await navigator.mediaDevices
		.getUserMedia({
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
		})
		.catch((error) => {
			console.error("[microphone] Could not open capture", error);
			throw new Error(t("recording.echoMicrophoneUnavailable"));
		});
	const track = stream.getAudioTracks()[0];
	let reader: ReadableStreamDefaultReader<AudioData>;
	try {
		const settings = track.getSettings() as Omit<MediaTrackSettings, "echoCancellation"> & {
			echoCancellation?: boolean | string;
		};
		if (settings.echoCancellation !== "all") {
			throw new Error(t("recording.echoCancellationUnavailable"));
		}
		reader = new Processor({ track, maxBufferSize: 50 }).readable.getReader();
	} catch (error) {
		stream.getTracks().forEach((item) => item.stop());
		console.error("[microphone] Echo cancellation unavailable", error);
		throw new Error(t("recording.echoCancellationUnavailable"));
	}
	let stopped = false;
	const stop = async () => {
		stopped = true;
		try {
			await reader.cancel();
		} catch {
			// An errored stream rejects cancellation too; the pump already reports that error.
		} finally {
			stream.getTracks().forEach((item) => item.stop());
		}
		// A stalled pipe write can outlive the recorder's stop timeout. Late replies
		// are ignored by the pump's stopped checks; cleanup must not wait for them.
	};
	return {
		start(recordingId, onError, onWarning) {
			void (async () => {
				let expectedTimestampUs: number | undefined;
				let warnedAboutGap = false;
				try {
					while (!stopped) {
						const { value: audio, done } = await reader.read();
						if (stopped) {
							audio?.close();
							break;
						}
						if (done) {
							throw new Error(t("recording.echoMicrophoneStopped"));
						}
						let packet: NativeMicrophonePacket;
						try {
							if (audio.sampleRate !== 48_000 || audio.numberOfChannels !== 1) {
								console.warn("[microphone] Audio format changed", {
									sampleRate: audio.sampleRate,
									channels: audio.numberOfChannels,
								});
								throw new Error(t("recording.echoMicrophoneStopped"));
							}
							const frameDurationUs = 1_000_000 / audio.sampleRate;
							if (
								!warnedAboutGap &&
								expectedTimestampUs !== undefined &&
								audio.timestamp - expectedTimestampUs > frameDurationUs
							) {
								warnedAboutGap = true;
								console.warn("[microphone] Capture timestamp gap", {
									recordingId,
									missingMs: (audio.timestamp - expectedTimestampUs) / 1_000,
								});
								onWarning(new Error(t("recording.echoMicrophoneGap")));
							}
							expectedTimestampUs = audio.timestamp + audio.numberOfFrames * frameDurationUs;
							const samples = new Float32Array(audio.numberOfFrames);
							audio.copyTo(samples, { planeIndex: 0, format: "f32-planar" });
							// AudioData retains the host capture timestamp, including AEC delay compensation.
							packet = { recordingId, timestampUs: audio.timestamp, samples };
						} finally {
							audio.close();
						}
						// One outstanding write bounds IPC/pipe backpressure to the processor's queue.
						try {
							await window.electronAPI.writeNativeMacMicrophone(packet);
						} catch (error) {
							if (!stopped) {
								console.error("[microphone] Recorder write failed", error);
								onError(new Error(t("recording.echoMicrophoneWriteFailed")));
							}
							break;
						}
					}
				} catch (error) {
					if (!stopped) {
						console.warn("[microphone] Capture stopped", error);
						onWarning(new Error(t("recording.echoMicrophoneStopped")));
					}
				} finally {
					stream.getTracks().forEach((item) => item.stop());
					await reader.cancel().catch(() => undefined);
				}
			})();
		},
		stop,
	};
}
