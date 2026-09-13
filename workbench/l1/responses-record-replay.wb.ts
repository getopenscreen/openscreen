import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname } from "node:path";
import { describe, expect, it } from "vitest";
import {
	type Cassette,
	readCassette,
	startRecorder,
	startReplay,
	writeCassette,
} from "../lib/cassette";
import { normalizeIds, offlineStore } from "../lib/harness";
import { startScriptedModel } from "../lib/model-server";
import { runRepetition } from "../lib/runner";
import { createInvocationBudget, publicHeaderProfile, transportIdentity } from "../lib/transport";
import { getScenario } from "../scenarios/registry";

const ROOT = "workbench/.agent-evidence/responses-validation/vitest";
const OPAQUE = "synthetic_opaque_reasoning_marker_A9C3";

function profile(maxRequests = 6) {
	const headers = publicHeaderProfile({
		"user-agent": "codex_exec/test-public",
		originator: "codex_exec",
	});
	const transport = transportIdentity({
		wireApi: "responses",
		maxOutputTokens: 2048,
		publicHeadersSha256: headers.sha256,
		limits: { maxRequests, invocationTimeoutMs: 30_000, requestTimeoutMs: 10_000 },
	});
	return { headers, transport };
}

function comparable(result: Awaited<ReturnType<typeof runRepetition>>) {
	return normalizeIds({
		ok: result.run.ok,
		answer: result.run.answer,
		document: result.run.document,
		tools: result.run.wire.calls.map((call) => ({
			name: call.name,
			args: call.args,
			result: call.resultJson,
		})),
	});
}

describe("native Responses record and replay", () => {
	it("runs read -> real addZoom -> final and carries opaque reasoning by call_id", async () => {
		const file = `${ROOT}/native-tool-loop.json`;
		const scripted = await startScriptedModel(
			[
				{
					kind: "tools",
					opaqueReasoning: OPAQUE,
					calls: [{ name: "getCurrentDocument", args: {} }],
				},
				{
					kind: "tools",
					opaqueReasoning: `${OPAQUE}_second`,
					calls: [{ name: "addZoom", args: { startSec: 43, endSec: 48, depth: 3 } }],
				},
				{ kind: "text", text: "Added the zoom to the demo clip." },
			],
			{ wireApi: "responses", model: "gpt-5-test" },
		);
		const { headers, transport } = profile();
		const recorder = await startRecorder({
			upstream: scripted.url,
			file,
			scenario: "target-right-clip",
			provider: "loopback",
			model: "gpt-5-test",
			wireApi: "responses",
			transport,
			publicHeaders: headers,
			budget: createInvocationBudget(transport.limits),
		});
		let recorded: Awaited<ReturnType<typeof runRepetition>>;
		try {
			recorded = await runRepetition({
				scenario: getScenario("target-right-clip"),
				endpoint: recorder,
				store: offlineStore({ baseUrl: recorder.url, allowAgentEdits: true, model: "gpt-5-test" }),
				maxRetries: 0,
			});
		} finally {
			recorder.close();
			scripted.close();
		}
		expect(recorded.run.ok, recorded.run.error).toBe(true);
		expect(recorded.context.after.zoomRanges).toHaveLength(1);
		expect(recorded.run.wire.calls.map((call) => call.name)).toEqual([
			"getCurrentDocument",
			"addZoom",
		]);
		const secondRequest = scripted.requests[1].raw as { input?: unknown[] };
		expect(secondRequest.input).toContainEqual(
			expect.objectContaining({ encrypted_content: OPAQUE }),
		);
		expect(secondRequest.input).toContainEqual(
			expect.objectContaining({ type: "function_call_output", call_id: "call_wb_0_0" }),
		);

		const cassette = readCassette(file);
		expect(cassette.rounds).toHaveLength(3);
		expect(cassette.rounds.every((round) => round.response?.byteCount)).toBe(true);
		expect(cassette.rounds.map((round) => round.usage)).toEqual([
			expect.objectContaining({ input_tokens: 100 }),
			expect.objectContaining({ input_tokens: 101 }),
			expect.objectContaining({ input_tokens: 102 }),
		]);

		const replay = await startReplay({ file, onStale: "throw" });
		let replayed: Awaited<ReturnType<typeof runRepetition>>;
		try {
			replayed = await runRepetition({
				scenario: getScenario("target-right-clip"),
				endpoint: replay,
				store: offlineStore({ baseUrl: replay.url, allowAgentEdits: true, model: cassette.model }),
				maxRetries: 0,
			});
			replay.assertFresh();
		} finally {
			replay.close();
		}
		expect(replay.staleRounds).toEqual([]);
		expect(comparable(replayed)).toEqual(comparable(recorded));
	});

	it("rejects omitted, unknown, and Chat-disguised Responses discriminators", () => {
		const source = JSON.parse(readFileSync(`${ROOT}/native-tool-loop.json`, "utf8"));
		const writeTamper = (name: string, mutate: (value: typeof source) => void): string => {
			const value = structuredClone(source);
			mutate(value);
			const file = `${ROOT}/discriminator-${name}-${randomUUID()}.json`;
			writeFileSync(file, JSON.stringify(value));
			return file;
		};

		const omitted = writeTamper("omitted", (value) => {
			delete value.wireApi;
		});
		expect(() => readCassette(omitted)).toThrow(/without a wireApi discriminator/);

		const unknown = writeTamper("unknown", (value) => {
			value.wireApi = "unknown-protocol";
		});
		expect(() => readCassette(unknown)).toThrow(/unknown cassette wireApi/);

		const explicitChat = writeTamper("chat", (value) => {
			value.wireApi = "chat-completions";
			value.transport = transportIdentity({ wireApi: "chat-completions" });
		});
		expect(() => readCassette(explicitChat)).toThrow(/Responses-only round evidence/);

		const stripped = writeTamper("stripped", (value) => {
			delete value.wireApi;
			delete value.transport;
			for (const round of value.rounds) {
				delete round.inboundPath;
				delete round.requestBodyBase64;
				delete round.requestByteCount;
				delete round.requestSha256;
				delete round.response;
				delete round.terminalStatus;
			}
		});
		expect(() => readCassette(stripped)).toThrow(/without a wireApi discriminator/);

		const explicitChatFile = `${ROOT}/explicit-chat-${randomUUID()}.json`;
		const chat: Cassette = {
			scenario: "explicit-chat-control",
			provider: "loopback",
			model: "chat-model",
			recordedAt: "2026-09-12T00:00:00.000Z",
			wireApi: "chat-completions",
			transport: transportIdentity({ wireApi: "chat-completions" }),
			rounds: [
				{
					round: 0,
					requestHash: "legacy-chat-hash",
					digest: {
						systemChars: 0,
						toolCount: 0,
						roles: ["user"],
						lastUserText: "Explain Responses",
					},
					sse: 'data: {"object":"chat.completion.chunk","choices":[{"delta":{"content":"The Responses API"}}]}\n\ndata: [DONE]\n\n',
				},
			],
		};
		writeCassette(explicitChatFile, chat);
		expect(readCassette(explicitChatFile).wireApi).toBe("chat-completions");
	});

	it("preserves fragmented UTF-8 and a non-2xx body/status/type byte for byte", async () => {
		const file = `${ROOT}/non-2xx-bytes.json`;
		const responseText = '{"error":"split 🙂 body"}';
		const bytes = Buffer.from(responseText);
		let upstreamCalls = 0;
		const upstream = createServer((_req, res) => {
			upstreamCalls += 1;
			res.writeHead(429, { "content-type": "application/problem+json; charset=utf-8" });
			const split = bytes.indexOf(Buffer.from("🙂")) + 2;
			res.write(bytes.subarray(0, split));
			res.end(bytes.subarray(split));
		});
		await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
		const address = upstream.address();
		if (!address || typeof address === "string") throw new Error("no address");
		const { headers, transport } = profile(1);
		const recorder = await startRecorder({
			upstream: `http://127.0.0.1:${address.port}`,
			file,
			scenario: "byte-failure",
			provider: "loopback",
			model: "gpt-5-test",
			wireApi: "responses",
			transport,
			publicHeaders: headers,
		});
		const body = JSON.stringify({
			model: "gpt-5-test",
			input: [],
			reasoning: { effort: "medium" },
		});
		try {
			const response = await fetch(`${recorder.url}/responses`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body,
			});
			expect(response.status).toBe(429);
			expect(response.headers.get("content-type")).toBe("application/problem+json; charset=utf-8");
			expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
		} finally {
			recorder.close();
			upstream.close();
		}
		expect(upstreamCalls).toBe(1);

		const replay = await startReplay({ file, onStale: "throw" });
		try {
			const response = await fetch(`${replay.url}/responses`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body,
			});
			expect(response.status).toBe(429);
			expect(response.headers.get("content-type")).toBe("application/problem+json; charset=utf-8");
			expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
			replay.assertFresh();
		} finally {
			replay.close();
		}
	});

	it("rejects byte-attestation drift and sends one request on provider failure", async () => {
		const file = `${ROOT}/non-2xx-bytes.json`;
		const tampered = `${ROOT}/tampered.json`;
		const value = JSON.parse(readFileSync(file, "utf8"));
		value.rounds[0].response.sha256 = "0".repeat(64);
		mkdirSync(dirname(tampered), { recursive: true });
		writeFileSync(tampered, JSON.stringify(value));
		expect(() => readCassette(tampered)).toThrow(/sha256 mismatch/);

		let calls = 0;
		const upstream = createServer((_req, res) => {
			calls += 1;
			res.writeHead(500, { "content-type": "application/json" });
			res.end('{"error":"synthetic failure"}');
		});
		await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
		const address = upstream.address();
		if (!address || typeof address === "string") throw new Error("no address");
		const { headers, transport } = profile(1);
		const recorder = await startRecorder({
			upstream: `http://127.0.0.1:${address.port}`,
			scenario: "one-failure",
			provider: "loopback",
			model: "gpt-5-test",
			wireApi: "responses",
			transport,
			publicHeaders: headers,
		});
		try {
			const failed = await runRepetition({
				scenario: getScenario("target-right-clip"),
				endpoint: recorder,
				store: offlineStore({
					baseUrl: recorder.url,
					allowAgentEdits: true,
					model: "gpt-5-test",
				}),
				maxRetries: 0,
			});
			expect(failed.run.ok).toBe(false);
		} finally {
			recorder.close();
			upstream.close();
		}
		expect(calls).toBe(1);
	});

	it("retains safe rejected attempts and never adopts unsafe response bytes", async () => {
		const scripted = await startScriptedModel([{ kind: "text", text: "done" }], {
			wireApi: "responses",
			model: "gpt-5-budget",
		});
		const { headers, transport } = profile(1);
		const file = `${ROOT}/budget-${randomUUID()}.json`;
		const recorder = await startRecorder({
			upstream: scripted.url,
			file,
			scenario: "budget",
			provider: "loopback",
			model: "gpt-5-budget",
			wireApi: "responses",
			transport,
			publicHeaders: headers,
		});
		const body = JSON.stringify({
			model: "gpt-5-budget",
			input: [],
			reasoning: { effort: "medium" },
		});
		try {
			const first = await fetch(`${recorder.url}/responses`, { method: "POST", body });
			expect(first.status).toBe(200);
			await first.text();
			const rejected = await fetch(`${recorder.url}/responses`, { method: "POST", body });
			expect(rejected.status).toBe(429);
		} finally {
			recorder.close();
			scripted.close();
		}
		expect(scripted.requests).toHaveLength(1);
		const attempts = JSON.parse(readFileSync(`${file}.attempts.json`, "utf8"));
		expect(attempts.attempts.map((attempt: { status: string }) => attempt.status)).toEqual([
			"recorded",
			"rejected",
		]);
		const incompleteCassette = readCassette(file);
		expect(incompleteCassette.rounds).toHaveLength(1);
		expect(incompleteCassette.attempts).toHaveLength(2);
		expect(incompleteCassette.attempts?.map((attempt) => attempt.status)).toEqual([
			"recorded",
			"rejected",
		]);

		const unsafeFile = `${ROOT}/unsafe-${randomUUID()}.json`;
		const unsafe = createServer((_req, res) => {
			res.writeHead(200, { "content-type": "text/event-stream" });
			res.end("data: Bearer synthetic-response-secret\n\n");
		});
		await new Promise<void>((resolve) => unsafe.listen(0, "127.0.0.1", resolve));
		const address = unsafe.address();
		if (!address || typeof address === "string") throw new Error("no address");
		const unsafeRecorder = await startRecorder({
			upstream: `http://127.0.0.1:${address.port}`,
			file: unsafeFile,
			scenario: "unsafe",
			provider: "loopback",
			model: "gpt-5-budget",
			wireApi: "responses",
			transport,
			publicHeaders: headers,
		});
		try {
			const response = await fetch(`${unsafeRecorder.url}/responses`, { method: "POST", body });
			expect(response.status).toBe(502);
		} finally {
			unsafeRecorder.close();
			unsafe.close();
		}
		expect(existsSync(unsafeFile)).toBe(false);
		const unsafeAttempts = JSON.parse(readFileSync(`${unsafeFile}.attempts.json`, "utf8"));
		expect(unsafeAttempts.attempts[0]).toMatchObject({
			phase: "response",
			status: "failed",
			detail: "unsafe upstream response",
		});
	});
});
