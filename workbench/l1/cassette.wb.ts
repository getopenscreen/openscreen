// L1 — record/replay. The recorder is what makes a live run reusable: once a
// turn is on tape, the same agent loop, the same prompt and the same tool
// schemas can be re-run offline in milliseconds.
//
// The two things that must hold: a replay reproduces the recorded document
// exactly, and a cassette that no longer matches the request says so instead of
// answering a question the app no longer asks.

import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
	hashRequest,
	mergeRetryCassettes,
	readCassette,
	startRecorder,
	startReplay,
	usageFromSse,
	writeCassette,
} from "../lib/cassette";
import { ENV_KEYS } from "../lib/env";
import { singleClip } from "../lib/fixtures";
import { normalizeIds, runScenario } from "../lib/harness";
import { startScriptedModel } from "../lib/model-server";

const DIRECTORY = mkdtempSync(join(tmpdir(), "wb-cassette-"));
const FILE = join(DIRECTORY, "wizard.json");
const USAGE_FILE = join(DIRECTORY, "usage.json");
const PROMPT = "enhance this recording";

async function startRawProvider(options: {
	sse: string;
	onRequest: (body: string) => void;
}): Promise<{ url: string; close: () => void }> {
	const server = createServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => {
			body += chunk;
		});
		req.on("end", () => {
			options.onRequest(body);
			res.writeHead(200, { "content-type": "text/event-stream" });
			res.end(options.sse);
		});
	});

	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("raw provider has no address");
	return {
		url: `http://127.0.0.1:${address.port}`,
		close: () => server.close(),
	};
}

afterAll(() => rmSync(DIRECTORY, { recursive: true, force: true }));

async function record() {
	// ponytail: stands in for the real provider. Live, `upstream` is the
	// provider base URL and the key rides through in the header the app already
	// set — the recorder forwards it without parsing it.
	const upstream = await startScriptedModel([
		{ kind: "tools", calls: [{ name: "getCurrentDocument", args: {} }] },
		{
			kind: "tools",
			calls: [
				{ name: "addZoom", args: { startSec: 3, endSec: 5, depth: 3 } },
				{ name: "addTrim", args: { startSec: 12, endSec: 14 } },
			],
		},
		{ kind: "text", text: "Added a zoom at 3s and cut 12-14s." },
	]);
	const recorder = await startRecorder({
		upstream: upstream.url,
		file: FILE,
		scenario: "wizard-enhance",
		provider: "openai-compatible",
		model: "fake-upstream",
	});
	try {
		return await runScenario({
			label: "cassette-record",
			prompt: PROMPT,
			document: singleClip(),
			endpoint: recorder,
		});
	} finally {
		recorder.close();
		upstream.close();
	}
}

describe("record then replay", () => {
	it("replaying reproduces the recorded document exactly", async () => {
		const recorded = await record();
		expect(recorded.ok).toBe(true);

		const replay = await startReplay({ file: FILE });
		let replayed: Awaited<ReturnType<typeof runScenario>>;
		try {
			replayed = await runScenario({
				label: "cassette-replay",
				prompt: PROMPT,
				document: singleClip(),
				endpoint: replay,
			});
		} finally {
			replay.close();
		}

		expect(replay.staleRounds).toEqual([]);
		expect(replayed.answer).toBe(recorded.answer);
		// Ids are freshly minted uuids on both sides, hence the normalization.
		expect(normalizeIds(replayed.document?.zoomRanges)).toEqual(
			normalizeIds(recorded.document?.zoomRanges),
		);
		expect(normalizeIds(replayed.document?.timeline.trimRanges)).toEqual(
			normalizeIds(recorded.document?.timeline.trimRanges),
		);
		// The wire transcript survives the round trip — that is what makes an
		// offline re-score of the DSL axis meaningful.
		expect(replayed.wire.calls.map((c) => c.name)).toEqual(recorded.wire.calls.map((c) => c.name));
	});

	it("never puts an authorization header on disk", () => {
		const cassette = readCassette(FILE);
		const blob = JSON.stringify(cassette);
		expect(blob).not.toContain("Bearer");
		expect(blob).not.toContain("authorization");
	});

	it("refuses to write a cassette carrying the key", () => {
		const saved = process.env[ENV_KEYS.apiKey];
		process.env[ENV_KEYS.apiKey] = "wb-not-a-real-key-0123456789";
		try {
			expect(() =>
				writeCassette(join(DIRECTORY, "leak.json"), {
					scenario: "leak",
					provider: "openai-compatible",
					model: "m",
					recordedAt: "2026-07-31",
					rounds: [
						{
							round: 0,
							requestHash: "x",
							digest: { systemChars: 0, toolCount: 0, roles: [], lastUserText: "" },
							sse: "data: wb-not-a-real-key-0123456789\n\n",
						},
					],
				}),
			).toThrow(/refus d'écrire la cassette/);
		} finally {
			if (saved === undefined) delete process.env[ENV_KEYS.apiKey];
			else process.env[ENV_KEYS.apiKey] = saved;
		}
	});

	it("marks a changed prompt as stale instead of answering the old question", async () => {
		const replay = await startReplay({ file: FILE });
		try {
			await runScenario({
				label: "cassette-stale",
				prompt: "a completely different request",
				document: singleClip(),
				endpoint: replay,
			});
		} finally {
			replay.close();
		}
		expect(replay.staleRounds.length).toBeGreaterThan(0);
		// A field nobody reads is not a guard; assertFresh is the enforceable form.
		expect(() => replay.assertFresh()).not.toThrow();
	});

	it("turns staleness into a hard failure under strict mode", async () => {
		const replay = await startReplay({ file: FILE, onStale: "throw" });
		try {
			await runScenario({
				label: "cassette-strict",
				prompt: "yet another request",
				document: singleClip(),
				endpoint: replay,
			});
		} finally {
			replay.close();
		}
		expect(() => replay.assertFresh()).toThrow(/périmée aux rounds/);
	});

	it("records final usage while preserving the request and raw SSE", async () => {
		const requestBody = JSON.stringify({
			model: "fake-upstream",
			stream: true,
			messages: [{ role: "user", content: "usage probe" }],
		});
		const firstUsage = {
			prompt_tokens: 4,
			completion_tokens: 2,
			total_tokens: 6,
			prompt_tokens_details: { cached_tokens: 2 },
			prompt_cache_hit_tokens: 2,
			prompt_cache_miss_tokens: 2,
		};
		const finalUsage = {
			prompt_tokens: 12,
			completion_tokens: 7,
			total_tokens: 19,
			prompt_tokens_details: { cached_tokens: 8 },
			completion_tokens_details: { reasoning_tokens: 3 },
			prompt_cache_hit_tokens: 8,
			prompt_cache_miss_tokens: 4,
			provider_detail: { trace: "preserved" },
		};
		const sse = [
			`data: ${JSON.stringify({ id: "usage-null", usage: null })}\n\n`,
			`data: ${JSON.stringify({ id: "usage-first", usage: firstUsage })}\n\n`,
			"data: {malformed\n\n",
			`data: ${JSON.stringify({ id: "usage-array", usage: [] })}\n\n`,
			`data: ${JSON.stringify({ id: "usage-final", usage: finalUsage })}\n\n`,
			"data: [DONE]\n\n",
			`data: ${JSON.stringify({ id: "after-done", usage: { prompt_tokens: 999 } })}\n\n`,
		].join("");
		let receivedBody = "";
		const upstream = await startRawProvider({
			sse,
			onRequest: (body) => {
				receivedBody = body;
			},
		});
		const recorder = await startRecorder({
			upstream: upstream.url,
			file: USAGE_FILE,
			scenario: "usage-probe",
			provider: "openai-compatible",
			model: "fake-upstream",
		});
		try {
			const response = await fetch(`${recorder.url}/chat/completions`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: requestBody,
			});
			expect(response.status).toBe(200);
			expect(await response.text()).toBe(sse);
		} finally {
			recorder.close();
			upstream.close();
		}

		expect(receivedBody).toBe(requestBody);
		const cassette = readCassette(USAGE_FILE);
		expect(cassette.rounds).toHaveLength(1);
		expect(cassette.rounds[0].sse).toBe(sse);
		expect(cassette.rounds[0].usage).toEqual(finalUsage);
	});

	it("records and replays usage across sixty rounds", async () => {
		let upstreamRound = 0;
		const upstream = createServer((_req, res) => {
			const round = upstreamRound;
			upstreamRound += 1;
			const usage = {
				prompt_tokens: round + 1,
				completion_tokens: 2,
				total_tokens: round + 3,
			};
			res.writeHead(200, { "content-type": "text/event-stream" });
			res.end(
				`data: ${JSON.stringify({ id: `usage-${round}`, model: "usage-model", usage })}\n\n` +
					"data: [DONE]\n\n",
			);
		});
		await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
		const address = upstream.address();
		if (!address || typeof address === "string") throw new Error("usage upstream has no address");
		const file = join(DIRECTORY, "usage-60.json");
		const recorder = await startRecorder({
			upstream: `http://127.0.0.1:${address.port}`,
			file,
			scenario: "usage-60",
			provider: "loopback",
			model: "usage-model",
		});
		const bodies = Array.from({ length: 60 }, (_, round) =>
			JSON.stringify({
				model: "usage-model",
				messages: [{ role: "user", content: `round ${round}` }],
			}),
		);
		try {
			for (const body of bodies) {
				const response = await fetch(`${recorder.url}/chat/completions`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body,
				});
				expect(response.status).toBe(200);
				await response.text();
			}
		} finally {
			recorder.close();
			upstream.close();
		}
		const cassette = readCassette(file);
		expect(cassette.rounds).toHaveLength(60);
		expect(cassette.rounds[0].usage).toEqual({
			prompt_tokens: 1,
			completion_tokens: 2,
			total_tokens: 3,
		});
		expect(cassette.rounds[59].usage).toEqual({
			prompt_tokens: 60,
			completion_tokens: 2,
			total_tokens: 62,
		});

		const replay = await startReplay({ file, onStale: "throw" });
		try {
			for (const body of bodies) {
				const response = await fetch(`${replay.url}/chat/completions`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body,
				});
				expect(response.status).toBe(200);
				await response.text();
			}
		} finally {
			replay.close();
		}
		expect(replay.staleRounds).toEqual([]);
		expect(() => replay.assertFresh()).not.toThrow();
	});

	it("records developer prompt length in proxy and upstream request digests", async () => {
		const prompt = "d".repeat(3_840);
		const body = {
			model: "workbench",
			messages: [
				{ role: "developer", content: prompt },
				{ role: "user", content: "preview" },
			],
		};
		const upstream = await startScriptedModel([{ kind: "text", text: "done" }]);
		const file = join(DIRECTORY, "developer-prompt.json");
		const recorder = await startRecorder({
			upstream: upstream.url,
			file,
			scenario: "developer-prompt",
			provider: "loopback",
			model: "workbench",
		});
		try {
			const response = await fetch(`${recorder.url}/chat/completions`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			});
			expect(response.status).toBe(200);
			await response.text();
		} finally {
			recorder.close();
			upstream.close();
		}
		expect(readCassette(file).rounds[0].digest).toMatchObject({
			systemChars: 3_840,
			roles: ["developer", "user"],
		});
		expect(upstream.requests[0].systemChars).toBe(3_840);
		expect(
			hashRequest({ ...body, messages: [{ role: "developer", content: `${prompt}!` }] }),
		).not.toBe(hashRequest(body));
	});

	it("keeps an existing system-only cassette request fresh", async () => {
		const body = {
			model: "legacy",
			messages: [
				{ role: "system", content: "legacy system prompt" },
				{ role: "user", content: "legacy user prompt" },
			],
			tools: [],
		};
		const file = join(DIRECTORY, "legacy-system-only.json");
		writeCassette(file, {
			scenario: "legacy-system-only",
			provider: "loopback",
			model: "legacy",
			recordedAt: "2026-07-31T00:00:00.000Z",
			rounds: [
				{
					round: 0,
					requestHash: hashRequest(body),
					digest: {
						systemChars: "legacy system prompt".length,
						toolCount: 0,
						roles: ["system", "user"],
						lastUserText: "legacy user prompt",
					},
					sse: "data: [DONE]\n\n",
				},
			],
		});
		const replay = await startReplay({ file, onStale: "throw" });
		try {
			const response = await fetch(`${replay.url}/chat/completions`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			});
			expect(response.status).toBe(200);
			await response.text();
		} finally {
			replay.close();
		}
		expect(replay.staleRounds).toEqual([]);
		expect(() => replay.assertFresh()).not.toThrow();
	});

	it("leaves usage unknown when no valid object appears", () => {
		const sse = [
			`data: ${JSON.stringify({ usage: null })}\n\n`,
			`data: ${JSON.stringify({ usage: [] })}\n\n`,
			"data: {malformed\n\n",
			"data: [DONE]\n\n",
		].join("");
		expect(usageFromSse(sse)).toBeUndefined();
	});

	it("parses usage from CRLF data lines without a separator space", () => {
		const usage = { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 };
		const sse = [`data:${JSON.stringify({ usage })}\r\n\r\n`, "data:[DONE]\r\n\r\n"].join("");
		expect(usageFromSse(sse)).toEqual(usage);
	});

	it("refuses an upstream redirect without forwarding the prompt to the new origin", async () => {
		let targetCalls = 0;
		const target = createServer((_req, res) => {
			targetCalls += 1;
			res.writeHead(200, { "content-type": "text/event-stream" });
			res.end("data: [DONE]\n\n");
		});
		await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
		const targetAddress = target.address();
		if (!targetAddress || typeof targetAddress === "string")
			throw new Error("target has no address");

		const redirect = createServer((_req, res) => {
			res.writeHead(307, {
				location: `http://127.0.0.1:${targetAddress.port}/v1/chat/completions`,
			});
			res.end();
		});
		await new Promise<void>((resolve) => redirect.listen(0, "127.0.0.1", resolve));
		const redirectAddress = redirect.address();
		if (!redirectAddress || typeof redirectAddress === "string") {
			throw new Error("redirect has no address");
		}
		const redirectFile = join(DIRECTORY, "redirect.json");
		const recorder = await startRecorder({
			upstream: `http://127.0.0.1:${redirectAddress.port}/v1`,
			file: redirectFile,
			scenario: "redirect-probe",
			provider: "loopback",
			model: "loopback",
		});
		try {
			const response = await fetch(`${recorder.url}/chat/completions`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: "Bearer test-only-value",
				},
				body: JSON.stringify({
					model: "loopback",
					messages: [{ role: "user", content: "private prompt" }],
				}),
			});
			expect(response.status).toBe(502);
			expect(await response.json()).toEqual({
				error: "workbench proxy: upstream redirect or transport failure",
			});
			expect(targetCalls).toBe(0);
			expect(() => readCassette(redirectFile)).toThrow();
		} finally {
			recorder.close();
			redirect.close();
			target.close();
		}
	});

	it("keeps failed retry attempts on the successful cassette", () => {
		const digest = { systemChars: 1, toolCount: 0, roles: ["user"], lastUserText: "retry" };
		const failed = {
			scenario: "retry-probe",
			provider: "loopback",
			model: "loopback",
			recordedAt: "2026-09-13T00:00:00.000Z",
			rounds: [
				{
					round: 0,
					requestHash: "0123456789abcdef",
					digest,
					sse: "data: [DONE]\n\n",
				},
			],
			attempts: [
				{ attempt: 0, phase: "forward" as const, status: "failed" as const, detail: "timeout" },
			],
		};
		const success = {
			...failed,
			attempts: [{ attempt: 0, phase: "complete" as const, status: "recorded" as const }],
		};
		const merged = mergeRetryCassettes(success, [failed]);
		expect(merged.rounds).toEqual(success.rounds);
		expect(merged.attempts).toEqual([
			{ attempt: 0, phase: "forward", status: "failed", detail: "timeout" },
			{ attempt: 1, phase: "complete", status: "recorded" },
		]);
	});

	it("rejects a Chat cassette whose rounds resolve to different models", () => {
		expect(() =>
			writeCassette(join(DIRECTORY, "mixed-models.json"), {
				scenario: "mixed-models",
				provider: "loopback",
				model: "alias",
				resolvedModel: "gpt-a",
				recordedAt: "2026-09-13T00:00:00.000Z",
				rounds: [
					{
						round: 0,
						requestHash: "0123456789abcdef",
						digest: { systemChars: 0, toolCount: 0, roles: ["user"], lastUserText: "a" },
						sse: `data: ${JSON.stringify({ model: "gpt-a" })}\n\ndata: [DONE]\n\n`,
					},
					{
						round: 1,
						requestHash: "fedcba9876543210",
						digest: { systemChars: 0, toolCount: 0, roles: ["user"], lastUserText: "b" },
						sse: `data: ${JSON.stringify({ model: "gpt-b" })}\n\ndata: [DONE]\n\n`,
					},
				],
			}),
		).toThrow(/model mismatch/);
	});

	it("fails closed when the concrete Chat model changes mid-measurement", async () => {
		let round = 0;
		const upstream = createServer((_req, res) => {
			const model = round === 0 ? "gpt-a" : "gpt-b";
			round += 1;
			res.writeHead(200, { "content-type": "text/event-stream" });
			res.end(`data: ${JSON.stringify({ model })}\n\ndata: [DONE]\n\n`);
		});
		await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
		const address = upstream.address();
		if (!address || typeof address === "string")
			throw new Error("model-change upstream has no address");
		const file = join(DIRECTORY, "model-change.json");
		const recorder = await startRecorder({
			upstream: `http://127.0.0.1:${address.port}`,
			file,
			scenario: "model-change",
			provider: "loopback",
			model: "alias",
		});
		try {
			const first = await fetch(`${recorder.url}/chat/completions`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					model: "alias",
					messages: [{ role: "user", content: "first" }],
				}),
			});
			expect(first.status).toBe(200);
			await first.text();
			const second = await fetch(`${recorder.url}/chat/completions`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					model: "alias",
					messages: [{ role: "user", content: "second" }],
				}),
			});
			expect(second.status).toBe(502);
			expect(await second.json()).toEqual({
				error: "workbench proxy: resolved model changed mid-measurement",
			});
		} finally {
			recorder.close();
			upstream.close();
		}
	});
});
