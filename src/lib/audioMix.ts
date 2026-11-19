/**
 * Mic gain applied when mixing the microphone with system audio into the recorder's
 * destination stream. Boosted slightly above unity so the voice is clearly audible
 * over typical system-audio levels.
 */
export const MIC_GAIN_BOOST = 1.4;

/**
 * The mic gain the native capture helpers should receive: boosted above unity
 * only when the mic has to sit over system audio, at unity on its own so a mic
 * that already runs hot does not get +2.9 dB it cannot spend — the native
 * mixers hard-clamp at full scale. This is the same rule mixAudioTracks applies
 * from track presence, expressed from the system-audio toggle the native
 * request builders know.
 */
export function nativeMicrophoneGain(systemAudioEnabled: boolean): number {
	return systemAudioEnabled ? MIC_GAIN_BOOST : 1;
}

/**
 * Duration of the mic fade-in applied at the start of a recording. Masks the
 * click/pop that the mic produces at its first packet (echo-canceller warm-up,
 * DC offset, gain-stage step) without audibly muting speech.
 */
export const MIC_FADE_IN_S = 0.02;

/** Bounds of the user's pre-recording volume trims, shared by the settings
 *  validation and the HUD sliders so both ends agree on what a legal value is. */
export const RECORDING_GAIN_DB_MIN = -24;
export const RECORDING_GAIN_DB_MAX = 12;

/** dB to the linear scalar the mixers multiply by (native helper and GainNode alike). */
export function recordingGainScalar(gainDb: number): number {
	return 10 ** (gainDb / 20);
}

export type MixAudioTracksInput = {
	systemAudioTrack?: MediaStreamTrack | null | undefined;
	micAudioTrack?: MediaStreamTrack | null | undefined;
	/** User trim on the microphone, dB on top of the automatic mix gain. */
	micGainDb?: number;
	/** User trim on the computer audio, dB. */
	systemGainDb?: number;
};

export type MixAudioTracksResult = {
	/** AudioContext created to mix the two tracks. `null` when no mixing was needed. */
	context: AudioContext | null;
	/** The track to add to the recorder's MediaStream, or `null` when neither input was given. */
	track: MediaStreamTrack | null;
};

/**
 * Combine system audio and the microphone into a single audio track for the recorder.
 *
 * Whenever a mic track is present it is routed through an AudioContext + GainNode with
 * a short fade-in so its first packet doesn't click — mic-only recordings (a common
 * mode) get the same anti-click treatment as mixed ones, so `context` is non-null
 * whenever a mic track is present. The mic is boosted above unity only when it has to
 * sit over system audio; on its own it rides at unity so mic-only loudness is unchanged.
 * Caller owns the returned `context` and must `.close()` it on teardown.
 *
 * - System audio only at unity trim: returned verbatim, no AudioContext created
 *   (no warm-up click). A non-unity system trim routes it through a GainNode.
 * - Neither present: returns `{ context: null, track: null }`.
 */
export function mixAudioTracks({
	systemAudioTrack,
	micAudioTrack,
	micGainDb = 0,
	systemGainDb = 0,
}: MixAudioTracksInput): MixAudioTracksResult {
	const systemGain = recordingGainScalar(systemGainDb);
	if (!micAudioTrack) {
		if (!systemAudioTrack || systemGain === 1) {
			return { context: null, track: systemAudioTrack ?? null };
		}
		const context = new AudioContext();
		const destination = context.createMediaStreamDestination();
		const systemSource = context.createMediaStreamSource(new MediaStream([systemAudioTrack]));
		const trim = context.createGain();
		trim.gain.value = systemGain;
		systemSource.connect(trim).connect(destination);
		return { context, track: destination.stream.getAudioTracks()[0] };
	}

	const context = new AudioContext();
	const destination = context.createMediaStreamDestination();
	if (systemAudioTrack) {
		const systemSource = context.createMediaStreamSource(new MediaStream([systemAudioTrack]));
		if (systemGain === 1) {
			systemSource.connect(destination);
		} else {
			const trim = context.createGain();
			trim.gain.value = systemGain;
			systemSource.connect(trim).connect(destination);
		}
	}
	// Unity when the mic is on its own; boosted only when competing with system
	// audio. The user's trim multiplies whichever base applies.
	const micTargetGain =
		nativeMicrophoneGain(Boolean(systemAudioTrack)) * recordingGainScalar(micGainDb);
	const micSource = context.createMediaStreamSource(new MediaStream([micAudioTrack]));
	const micGain = context.createGain();
	micGain.gain.setValueAtTime(0, context.currentTime);
	micGain.gain.linearRampToValueAtTime(micTargetGain, context.currentTime + MIC_FADE_IN_S);
	micSource.connect(micGain).connect(destination);
	return { context, track: destination.stream.getAudioTracks()[0] };
}
