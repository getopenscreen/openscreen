export type TranscriptionProvider = "whisper" | "gmi" | "agy";

export interface TranscriptionSettingsSnapshot {
	provider: TranscriptionProvider;
	cloudConsent: boolean;
	/** Omitted by older clients; the store defaults to automatic transcription. */
	autoTranscribe?: boolean;
	hasApiKey: boolean;
	/** Separate consent: agreeing to GMI does not authorize AGY uploads. */
	agyCloudConsent?: boolean;
	/** Opt-in script preference; omitted preserves the recognizer output. */
	traditionalChinese?: boolean;
	/** Executable discovery only; authentication is checked when a run starts. */
	agyAvailable?: boolean;
}

export interface TranscriptionSettingsUpdate {
	provider?: TranscriptionProvider;
	agyCloudConsent?: boolean;
	/** Opt-in script preference; omitted preserves the recognizer output. */
	traditionalChinese?: boolean;
	cloudConsent?: boolean;
	autoTranscribe?: boolean;
	/** Empty clears the credential; omitted keeps it. Never returned in a snapshot. */
	apiKey?: string;
}
