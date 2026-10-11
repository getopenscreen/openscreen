import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GmiTranscriptionProvider } from "./gmiProvider";

const servers: ReturnType<typeof createServer>[] = [];

async function server(
	handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<string> {
	const http = createServer(handler);
	servers.push(http);
	await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
	return `http://127.0.0.1:${(http.address() as AddressInfo).port}/generateContent`;
}

function reply(res: ServerResponse, segments: unknown, finishReason = "STOP"): void {
	res.setHeader("Content-Type", "application/json");
	res.end(
		JSON.stringify({
			candidates: [
				{
					finishReason,
					content: {
						parts: [
							{
								text: JSON.stringify({
									detectedLanguage: "zh",
									segments,
								}),
							},
						],
					},
				},
			],
			modelVersion: "gemini-3-flash-preview",
		}),
	);
}

afterEach(async () => {
	vi.unstubAllGlobals();
	for (const http of servers.splice(0)) {
		http.closeAllConnections();
		await new Promise<void>((resolve) => http.close(() => resolve()));
	}
});

describe("GMI timed transcription", () => {
	it("reports the real fetch timeout instead of trying to mutate a DOMException message", async () => {
		const endpoint = await server((_req, _res) => {
			// A real request that never responds produces Node's read-only TimeoutError DOMException.
		});
		const failure = await new GmiTranscriptionProvider({ endpoint, timeoutMs: 30 })
			.transcribe({ samples: new Float32Array(16_000), apiKey: "test-secret" })
			.catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(Error);
		expect(failure).toMatchObject({ name: "TimeoutError" });
		expect((failure as Error).message).toMatch(/timeout/i);
		expect((failure as Error).message).not.toMatch(/Cannot set property|only a getter/i);
	});

	it("redacts a frozen network error without mutating the original error", async () => {
		const original = new Error("network rejected test-secret");
		original.name = "NetworkError";
		Object.freeze(original);
		vi.stubGlobal("fetch", () => Promise.reject(original));
		const failure = await new GmiTranscriptionProvider()
			.transcribe({ samples: new Float32Array(16_000), apiKey: "test-secret" })
			.catch((error: unknown) => error);
		expect(failure).toMatchObject({ name: "NetworkError", message: "network rejected [REDACTED]" });
		expect(failure).not.toBe(original);
		expect(original.message).toBe("network rejected test-secret");
	});

	it("identifies a response-body deadline as a timeout rather than user cancellation", async () => {
		const endpoint = await server((_req, res) => {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.flushHeaders();
			res.write('{"candidates":[');
			// Headers succeed; the unfinished body must still be bounded by the deadline.
		});
		const failure = await new GmiTranscriptionProvider({ endpoint, timeoutMs: 100 })
			.transcribe({ samples: new Float32Array(16_000), apiKey: "test-secret" })
			.catch((error: unknown) => error);
		expect(failure).toMatchObject({ name: "TimeoutError" });
		expect((failure as Error).message).toMatch(/timeout/i);
	});

	it("preserves the source Chinese script unless conversion is requested", async () => {
		const endpoint = await server((_req, res) =>
			reply(res, [{ startSec: 0.25, endSec: 1.5, text: "这个软件" }]),
		);
		const result = await new GmiTranscriptionProvider({ endpoint }).transcribe({
			samples: new Float32Array(32000),
			apiKey: "test-secret",
			language: "zh",
		});
		expect(result.segments[0].text).toBe("这个软件");
	});

	it("sends audio only in the request body and returns Taiwan Traditional timed phrases", async () => {
		let body = "";
		let authorization = "";
		let url = "";
		const endpoint = await server((req, res) => {
			authorization = req.headers.authorization ?? "";
			url = req.url ?? "";
			req.setEncoding("utf8");
			req.on("data", (data) => {
				body += data;
			});
			req.on("end", () =>
				reply(res, [{ startSec: 0.25, endSec: 1.5, text: "这个软件支持 Gemini 模型。" }]),
			);
		});
		const result = await new GmiTranscriptionProvider({
			endpoint,
			maxOutputTokens: 4096,
		}).transcribe({
			samples: new Float32Array(32_000).fill(0.25),
			apiKey: "test-secret",
			language: "zh",
			traditionalChinese: true,
		});
		expect(result.segments).toEqual([
			{ startSec: 0.25, endSec: 1.5, text: "這個軟體支援 Gemini 模型。" },
		]);
		expect(result.wordSegments).toEqual([]);
		expect(result.backend).toBe("gmi-gemini");
		expect(result.detectedLanguage).toBe("zh");
		expect(authorization).toBe("Bearer test-secret");
		expect(url).not.toContain("test-secret");
		expect(body).not.toContain("test-secret");
		const payload = JSON.parse(body);
		const audio = payload.contents[0].parts[1].inlineData;
		expect(audio.mimeType).toBe("audio/wav");
		const bytes = Buffer.from(audio.data, "base64");
		expect(bytes.subarray(0, 4).toString()).toBe("RIFF");
		expect(bytes.readUInt32LE(24)).toBe(16_000);
		expect(payload.generationConfig.responseMimeType).toBe("application/json");
		expect(payload.generationConfig.maxOutputTokens).toBe(4096);
		expect(payload.generationConfig.responseSchema.properties.segments.items.required).toEqual([
			"startSec",
			"endSec",
			"text",
		]);
	});

	it.each([
		[{ startSec: -0.1, endSec: 1, text: "bad" }],
		[{ startSec: 1, endSec: 0.5, text: "bad" }],
		[{ startSec: 0, endSec: 3, text: "bad" }],
		[{ startSec: "0", endSec: 1, text: "bad" }],
		[{ startSec: 0, endSec: 1, text: "" }],
		[
			{ startSec: 0.5, endSec: 1, text: "a" },
			{ startSec: 0.25, endSec: 0.75, text: "b" },
		],
	])("rejects malformed or impossible timestamps rather than fabricating a caption", async (...segments) => {
		const endpoint = await server((_req, res) => reply(res, segments));
		await expect(
			new GmiTranscriptionProvider({ endpoint }).transcribe({
				samples: new Float32Array(32_000),
				apiKey: "test-secret",
			}),
		).rejects.toThrow(/timestamp|segment/i);
	});

	it("rejects a token-truncated response even if it contains valid-looking segments", async () => {
		const endpoint = await server((_req, res) =>
			reply(res, [{ startSec: 0, endSec: 1, text: "不完整" }], "MAX_TOKENS"),
		);
		await expect(
			new GmiTranscriptionProvider({ endpoint }).transcribe({
				samples: new Float32Array(32_000),
				apiKey: "test-secret",
			}),
		).rejects.toThrow(/MAX_TOKENS/);
	});

	it("redacts an echoed credential from an HTTP failure and never retries it", async () => {
		let calls = 0;
		const endpoint = await server((_req, res) => {
			calls++;
			res.statusCode = 401;
			res.end('{"error":"invalid test-secret"}');
		});
		const error = await new GmiTranscriptionProvider({ endpoint })
			.transcribe({
				samples: new Float32Array(32_000),
				apiKey: "test-secret",
			})
			.catch((error: unknown) => error);
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toContain("HTTP 401");
		expect((error as Error).message).not.toContain("test-secret");
		expect(calls).toBe(1);
	});

	it("aborts an in-flight upload/request without returning a fake empty transcript", async () => {
		let started!: () => void;
		const requestStarted = new Promise<void>((resolve) => {
			started = resolve;
		});
		const endpoint = await server((_req, _res) => started());
		const controller = new AbortController();
		const pending = new GmiTranscriptionProvider({ endpoint }).transcribe({
			samples: new Float32Array(32_000),
			apiKey: "test-secret",
			signal: controller.signal,
		});
		await requestStarted;
		controller.abort();
		await expect(pending).rejects.toMatchObject({ name: "AbortError" });
	});

	it("allows an explicit no-speech result without inventing timestamps", async () => {
		const endpoint = await server((_req, res) => reply(res, []));
		const result = await new GmiTranscriptionProvider({ endpoint }).transcribe({
			samples: new Float32Array(32_000),
			apiKey: "test-secret",
		});
		expect(result.segments).toEqual([]);
	});
});
