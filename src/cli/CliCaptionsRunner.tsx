// Hidden-window runner for `openscreen captions`: transcribes the project's primary media
// with the editor's own on-device Whisper path (`transcribeAsset`) and turns its captions
// on (`captionProject.ts`). The main process writes the project back.

import { useEffect, useRef } from "react";
import { type TranscribeStatus, transcribeAsset } from "@/lib/ai-edition/document/transcribe";
import { classifyTranscriptionError } from "@/lib/ai-edition/transcription/status";
import type { CliCaptionsRequest, CliDoneResult } from "@/lib/cliContracts";
import { captionProject } from "./captionProject";
import { loadCliProject } from "./loadCliProject";

async function runCaptions(request: CliCaptionsRequest): Promise<CliDoneResult> {
	const { document } = await loadCliProject(request.projectPath);

	// `onStatus` fires once per transcribed chunk, so log only on a phase change: a long
	// transcription would otherwise print one identical line per chunk.
	let loggedPhase: TranscribeStatus["phase"] | null = null;
	const onStatus = ({ phase }: TranscribeStatus) => {
		if (phase === loggedPhase) return;
		loggedPhase = phase;
		window.electronAPI.cliLog(
			"info",
			phase === "extracting-audio"
				? "Extracting audio…"
				: phase === "loading-model"
					? "Loading the speech model…"
					: "Transcribing…",
		);
	};

	const result = await captionProject(
		document,
		{
			minWordsPerLine: request.minWordsPerCaption,
			maxWordsPerLine: request.maxWordsPerCaption,
		},
		(doc, assetId) =>
			transcribeAsset(doc, assetId, { onStatus }).catch((error: unknown) => {
				throw new Error(`Transcription failed: ${classifyTranscriptionError(error).message}`);
			}),
	);
	if (!result.transcribed) {
		window.electronAPI.cliLog("info", "Using the transcript the project already has.");
	}

	return {
		success: true,
		projectPath: request.projectPath,
		projectData: result.document,
		captionCount: result.captionCount,
	};
}

export function CliCaptionsRunner() {
	const startedRef = useRef(false);

	useEffect(() => {
		if (startedRef.current) return;
		startedRef.current = true;

		void (async () => {
			try {
				const request = await window.electronAPI.cliGetRequest();
				if (request.kind !== "captions") {
					throw new Error(`cli-captions window received a ${request.kind} request`);
				}
				const result = await runCaptions(request);
				await window.electronAPI.cliDone(result);
			} catch (error) {
				// The message alone: every failure here is one the user acts on (no speech, a
				// transcription that failed, a project that does not load), not a bug to trace.
				const message = error instanceof Error ? error.message : String(error);
				await window.electronAPI.cliDone({ success: false, error: message });
			}
		})();
	}, []);

	return (
		<div className="flex h-screen items-center justify-center bg-[#09090b] text-white/60 text-sm">
			Generating captions…
		</div>
	);
}

export default CliCaptionsRunner;
