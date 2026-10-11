export type SourceAudioFormat = "original" | "wav" | "m4a";

export interface SourceAudioExportRequest {
	sourcePath: string;
	format: SourceAudioFormat;
}

export interface SourceSrtExportRequest {
	sourcePath: string;
	srtText: string;
	scope?: "source" | "timeline";
}

export interface SourceExportResult {
	success: boolean;
	canceled?: boolean;
	path?: string;
	error?: string;
}
