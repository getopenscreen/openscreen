import type { AxcutTranscript } from "../schema";
import { transcriptFromSegments } from "./fromStt";

export type SrtErrorCode =
	| "empty"
	| "index"
	| "timestamp"
	| "duration"
	| "bounds"
	| "markup"
	| "overlap"
	| "text";
export class SrtImportError extends Error {
	constructor(
		public readonly code: SrtErrorCode,
		public readonly cue: number,
		public readonly line: number,
	) {
		super(`SRT ${code} (cue ${cue}, line ${line})`);
	}
}

/** Validate the whole file before returning a transcript. All times refer to source media. */
export function transcriptFromSrt(
	assetId: string,
	input: string,
	durationSec: number,
	fileName: string,
): AxcutTranscript {
	const lines = input
		.replace(/^\uFEFF/, "")
		.replace(/\r\n?/g, "\n")
		.split("\n");
	const segments: { startSec: number; endSec: number; text: string }[] = [];
	let i = 0;
	const fail = (code: SrtErrorCode, line = i + 1): never => {
		throw new SrtImportError(code, segments.length + 1, line);
	};
	while (i < lines.length) {
		if (!lines[i].trim()) {
			i++;
			continue;
		}
		if (!/^\d+$/.test(lines[i].trim()) || Number(lines[i].trim()) < 1) fail("index");
		i++;
		const match =
			/^(\d{2,}):([0-5]\d):([0-5]\d),(\d{3}) --> (\d{2,}):([0-5]\d):([0-5]\d),(\d{3})$/.exec(
				lines[i]?.trim() ?? "",
			);
		if (!match) fail("timestamp");
		const m = match!;
		const startSec = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000;
		const endSec = Number(m[5]) * 3600 + Number(m[6]) * 60 + Number(m[7]) + Number(m[8]) / 1000;
		if (endSec <= startSec) fail("duration");
		if (!Number.isFinite(durationSec) || durationSec <= 0 || endSec > durationSec) fail("bounds");
		if (segments.length && startSec < segments[segments.length - 1].endSec) fail("overlap");
		i++;
		const textLine = i + 1;
		const textLines: string[] = [];
		while (i < lines.length && lines[i].trim()) textLines.push(lines[i++]);
		const text = textLines
			.join("\n")
			.replace(/<\/?(?:b|i|u)>/gi, "")
			.trim();
		if (!text) fail("text", textLine);
		if (/<[^>]*>|\{\\[^}]*\}/.test(text)) fail("markup", textLine);
		segments.push({ startSec, endSec, text });
	}
	if (!segments.length) fail("empty", 1);
	const result = transcriptFromSegments(assetId, segments, "auto");
	const prefix = `srt_${crypto.randomUUID()}_`;
	return {
		...result,
		importSource: { format: "srt", fileName, wordTiming: "estimated" },
		segments: result.segments.map((s) => ({
			...s,
			id: prefix + s.id,
			wordIds: s.wordIds.map((id) => prefix + id),
		})),
		words: result.words.map((w) => ({ ...w, id: prefix + w.id, segmentId: prefix + w.segmentId })),
	};
}
