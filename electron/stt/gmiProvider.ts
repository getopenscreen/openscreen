import { readFile } from "node:fs/promises";
import { Converter } from "opencc-js";
import type { SttPhraseSegment, SttTranscribeResponse } from "./transcriptionContract";
import { cleanupWav, writeSamplesAsWav } from "./wav";

export const GMI_STT_MODEL = "gemini-3-flash-preview";
const ENDPOINT = `https://api.gmi-serving.com/v1/models/${GMI_STT_MODEL}:generateContent`;
const SAMPLE_RATE = 16_000;
const MAX_INLINE_REQUEST_BYTES = 20_000_000;
const toTaiwanTraditional = Converter({ from: "cn", to: "twp" });

export interface GmiTranscribeChunkRequest {
	samples: Float32Array;
	apiKey: string;
	language?: string;
	traditionalChinese?: boolean;
	signal?: AbortSignal;
}

interface GmiProviderOptions {
	/** Dependency injection for local HTTP contract tests; never configurable in the renderer. */
	endpoint?: string;
	timeoutMs?: number;
	maxOutputTokens?: number;
}

const RESPONSE_SCHEMA = {
	type: "OBJECT",
	properties: {
		detectedLanguage: { type: "STRING" },
		segments: {
			type: "ARRAY",
			items: {
				type: "OBJECT",
				properties: {
					startSec: { type: "NUMBER" },
					endSec: { type: "NUMBER" },
					text: { type: "STRING" },
				},
				required: ["startSec", "endSec", "text"],
			},
		},
	},
	required: ["detectedLanguage", "segments"],
};

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reject invalid model timestamps; never fabricate, clamp, or spread words over fake spans. */
function parseTranscript(
	value: unknown,
	durationSec: number,
	traditionalChinese: boolean,
): {
	segments: SttPhraseSegment[];
	detectedLanguage: string;
} {
	if (
		!isObject(value) ||
		!Array.isArray(value.segments) ||
		typeof value.detectedLanguage !== "string"
	) {
		throw new Error("GMI returned an invalid timed transcript/segments JSON");
	}
	const segments: SttPhraseSegment[] = [];
	let previousEnd = 0;
	for (const segment of value.segments) {
		if (
			!isObject(segment) ||
			typeof segment.text !== "string" ||
			!segment.text.trim() ||
			typeof segment.startSec !== "number" ||
			typeof segment.endSec !== "number" ||
			!Number.isFinite(segment.startSec) ||
			!Number.isFinite(segment.endSec) ||
			segment.startSec < previousEnd ||
			segment.endSec <= segment.startSec ||
			segment.endSec > durationSec
		) {
			throw new Error("GMI returned invalid, overlapping, or out-of-range segment timestamps");
		}
		segments.push({
			startSec: segment.startSec,
			endSec: segment.endSec,
			text: traditionalChinese ? toTaiwanTraditional(segment.text.trim()) : segment.text.trim(),
		});
		previousEnd = segment.endSec;
	}
	const language = value.detectedLanguage.trim();
	if (!language || language === "auto") throw new Error("GMI did not report a detected language");
	return { segments, detectedLanguage: language.startsWith("zh") ? "zh" : language };
}

function readCandidate(response: unknown): unknown {
	if (
		!isObject(response) ||
		!Array.isArray(response.candidates) ||
		response.candidates.length === 0
	) {
		throw new Error("GMI returned no timed transcript candidate");
	}
	const candidate: unknown = response.candidates[0];
	if (!isObject(candidate) || candidate.finishReason !== "STOP") {
		const reason = isObject(candidate)
			? String(candidate.finishReason ?? "missing finishReason")
			: "invalid";
		throw new Error(`GMI transcription did not finish: ${reason}`);
	}
	if (!isObject(candidate.content) || !Array.isArray(candidate.content.parts)) {
		throw new Error("GMI returned an invalid transcript response");
	}
	const text = candidate.content.parts
		.filter(
			(part: unknown) => isObject(part) && part.thought !== true && typeof part.text === "string",
		)
		.map((part: Record<string, unknown>) => part.text)
		.join("");
	try {
		return JSON.parse(text);
	} catch {
		throw new Error("GMI returned unreadable timed transcript JSON");
	}
}

/** Cloud recognizer only. The manager owns consent, provider routing, chunk offsets, and progress. */
export class GmiTranscriptionProvider {
	private readonly endpoint: string;
	private readonly timeoutMs: number;
	private readonly maxOutputTokens: number;

	constructor(options: GmiProviderOptions = {}) {
		this.endpoint = options.endpoint ?? ENDPOINT;
		this.timeoutMs = options.timeoutMs ?? 120_000;
		this.maxOutputTokens = options.maxOutputTokens ?? 8192;
		if (
			!Number.isInteger(this.maxOutputTokens) ||
			this.maxOutputTokens < 1 ||
			this.maxOutputTokens > 8192
		) {
			throw new Error("GMI maxOutputTokens must be an integer between 1 and 8192");
		}
	}

	async transcribe(request: GmiTranscribeChunkRequest): Promise<SttTranscribeResponse> {
		const key = request.apiKey.trim();
		if (!key) throw new Error("GMI transcription requires an API key");
		if (request.signal?.aborted) throw new DOMException("Transcription cancelled", "AbortError");
		if (request.samples.length === 0) throw new Error("GMI received an empty audio chunk");
		const durationSec = request.samples.length / SAMPLE_RATE;
		const wavPath = await writeSamplesAsWav(request.samples);
		try {
			const audio = await readFile(wavPath);
			const prompt =
				"請逐字轉錄這段音訊，保留原語言，不摘要不補寫。" +
				(request.traditionalChinese ? "中文一律使用臺灣繁體中文。" : "保留中文原文用字。") +
				"回傳 detectedLanguage（ISO 639-1）與 segments。每段以自然短句分段，包含音訊內實際開始與結束" +
				"秒數 startSec/endSec 和 text。時間從這個音訊片段的 0 秒開始，非 MM:SS，段落不可重疊，" +
				`不可超過 ${durationSec.toFixed(5)} 秒。無人聲回傳空 segments，不替靜音編造字幕。` +
				(request.language && request.language !== "auto"
					? `辨識語言提示：${request.language}。`
					: "");
			const body = JSON.stringify({
				contents: [
					{
						role: "user",
						parts: [
							{ text: prompt },
							{ inlineData: { mimeType: "audio/wav", data: audio.toString("base64") } },
						],
					},
				],
				generationConfig: {
					responseMimeType: "application/json",
					responseSchema: RESPONSE_SCHEMA,
					maxOutputTokens: this.maxOutputTokens,
					temperature: 0,
				},
			});
			if (Buffer.byteLength(body, "utf8") > MAX_INLINE_REQUEST_BYTES) {
				throw new Error("GMI inline audio request exceeds the 20 MB limit; use shorter chunks");
			}
			const timeout = AbortSignal.timeout(this.timeoutMs);
			const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;
			const started = performance.now();
			const response = await fetch(this.endpoint, {
				method: "POST",
				signal,
				headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
				body,
			});
			// Also redact an unexpected provider echo before parsing it or reporting its error.
			const text = (await response.text()).split(key).join("[REDACTED]");
			if (!response.ok)
				throw new Error(`GMI transcription HTTP ${response.status}: ${text.slice(0, 512)}`);
			let parsed: unknown;
			try {
				parsed = JSON.parse(text);
			} catch {
				throw new Error("GMI returned unreadable response JSON");
			}
			const transcript = parseTranscript(
				readCandidate(parsed),
				durationSec,
				request.traditionalChinese === true,
			);
			if (request.signal?.aborted) throw new DOMException("Transcription cancelled", "AbortError");
			const elapsedSec = (performance.now() - started) / 1000;
			return {
				...transcript,
				wordSegments: [],
				backend: "gmi-gemini",
				timing: { elapsedSec, audioSec: durationSec, rtf: elapsedSec / durationSec },
			};
		} catch (error: unknown) {
			if (request.signal?.aborted) throw new DOMException("Transcription cancelled", "AbortError");
			// DOMException.message is getter-only; frozen provider errors are immutable too.
			// Wrap a sanitized copy so redaction cannot mask the original timeout/network error.
			const message = error instanceof Error ? error.message : String(error);
			const sanitized = new Error(message.split(key).join("[REDACTED]"));
			sanitized.name = error instanceof Error ? error.name : "Error";
			throw sanitized;
		} finally {
			await cleanupWav(wavPath);
		}
	}
}
