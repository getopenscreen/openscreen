// Record/replay for legacy Chat Completions and native Responses. Legacy
// cassettes keep their text-only contract; Responses attests exact decoded
// HTTP entity bytes and binds the full transport policy.

import { createHash, randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { dirname } from "node:path";
import { containsSecret } from "./env";
import { normalizeIds } from "./harness";
import type { CapturedRequest, ModelServerHandle } from "./model-server";
import {
	applyRequestPolicy,
	createInvocationBudget,
	DEFAULT_TRANSPORT_LIMITS,
	type InvocationBudget,
	type PublicHeaderProfile,
	publicHeaderProfile,
	type TransportIdentity,
	transportIdentity,
	type WireApi,
} from "./transport";
import { instructionContentTextOf } from "./wire";

export interface ResponseByteEvidence {
	bodyBase64: string;
	byteCount: number;
	sha256: string;
	status: number;
	contentType: string | null;
}

export interface CassetteRound {
	round: number;
	requestHash: string;
	digest: { systemChars: number; toolCount: number; roles: string[]; lastUserText: string };
	/** Legacy Chat payload and decoded compatibility field for Responses. */
	sse: string;
	usage?: Record<string, unknown>;
	inboundPath?: string;
	requestBodyBase64?: string;
	requestByteCount?: number;
	requestSha256?: string;
	response?: ResponseByteEvidence;
	terminalStatus?: "completed" | "incomplete" | "failed" | "missing";
	/** Chat Completions HTTP status. Absent on historical text-only cassettes. */
	httpStatus?: number;
}

export interface Cassette {
	scenario: string;
	provider: string;
	model: string;
	resolvedModel?: string;
	recordedAt: string;
	rounds: CassetteRound[];
	/** Absent means the historical Chat Completions text-only schema. */
	wireApi?: WireApi;
	transport?: TransportIdentity;
	attempts?: CassetteAttempt[];
}

export interface CassetteAttempt {
	attempt: number;
	phase: "admission" | "forward" | "response" | "complete";
	status: "rejected" | "failed" | "recorded";
	detail?: string;
}

interface ResponsesTerminal {
	status: CassetteRound["terminalStatus"];
	usage?: Record<string, unknown>;
	model: string | null;
}

function sha256(value: string | Uint8Array): string {
	return createHash("sha256").update(value).digest("hex");
}

function ssePayloads(sse: string): unknown[] {
	const payloads: unknown[] = [];
	for (const line of sse.split(/\r?\n/)) {
		if (!line.startsWith("data:")) continue;
		const payload = line.slice(5).trim();
		if (!payload || payload === "[DONE]") continue;
		try {
			payloads.push(JSON.parse(payload));
		} catch {
			// A protocol-specific parser decides whether malformed data is fatal.
		}
	}
	return payloads;
}

export function modelFromSse(sse: string, wireApi: WireApi = "chat-completions"): string | null {
	if (wireApi === "responses") return responsesTerminalFromSse(sse).model;
	for (const line of sse.split("\n")) {
		if (!line.startsWith("data: ")) continue;
		const payload = line.slice(6).trim();
		if (payload === "[DONE]") break;
		try {
			const model = (JSON.parse(payload) as { model?: unknown }).model;
			if (typeof model === "string" && model.length > 0) return model;
		} catch {
			// Legacy parser ignores malformed chunks.
		}
	}
	return null;
}

export function usageFromSse(
	sse: string,
	wireApi: WireApi = "chat-completions",
): Record<string, unknown> | undefined {
	if (wireApi === "responses") return responsesTerminalFromSse(sse).usage;
	let usage: Record<string, unknown> | undefined;
	for (const line of sse.split("\n")) {
		if (!line.startsWith("data:")) continue;
		const payload = line.slice(5).trim();
		if (payload === "[DONE]") break;
		try {
			const candidate = (JSON.parse(payload) as { usage?: unknown }).usage;
			if (candidate !== null && typeof candidate === "object" && !Array.isArray(candidate)) {
				usage = candidate as Record<string, unknown>;
			}
		} catch {
			// Legacy parser ignores malformed chunks.
		}
	}
	return usage;
}

export function responsesTerminalFromSse(sse: string): ResponsesTerminal {
	const terminals = ssePayloads(sse).filter((payload) => {
		const type = (payload as { type?: unknown }).type;
		return (
			type === "response.completed" || type === "response.incomplete" || type === "response.failed"
		);
	}) as Array<{ type: string; response?: unknown }>;
	if (terminals.length === 0) return { status: "missing", model: null };
	if (terminals.length !== 1) throw new Error("Responses stream has duplicate terminal events");
	const terminal = terminals[0];
	const response =
		terminal.response && typeof terminal.response === "object"
			? (terminal.response as Record<string, unknown>)
			: {};
	const usage =
		response.usage && typeof response.usage === "object" && !Array.isArray(response.usage)
			? (response.usage as Record<string, unknown>)
			: undefined;
	const model = typeof response.model === "string" && response.model ? response.model : null;
	const responseStatus = response.status;
	if (
		(terminal.type === "response.completed" && responseStatus !== "completed") ||
		(terminal.type === "response.incomplete" && responseStatus !== "incomplete") ||
		(terminal.type === "response.failed" && responseStatus !== "failed")
	) {
		throw new Error("Responses terminal event/status mismatch");
	}
	const status =
		terminal.type === "response.completed"
			? "completed"
			: terminal.type === "response.incomplete"
				? "incomplete"
				: "failed";
	return { status, usage, model };
}

/** Historical Chat hash. Keep byte-for-byte semantics for existing cassettes. */
export function hashRequest(body: Record<string, unknown>): string {
	const messages = (body.messages ?? []) as Array<Record<string, unknown>>;
	const tools = (body.tools ?? []) as Array<{ function?: { name?: string } }>;
	const canonical = JSON.stringify(
		normalizeIds({
			messages: messages.map((m) => ({ role: m.role, content: m.content, tc: m.tool_calls })),
			tools: tools.map((t) => t.function?.name),
		}),
	);
	return sha256(canonical).slice(0, 16);
}

/** Transport-bound Chat hash. Includes tool schemas, temperature, and model options. */
export function hashChatRequest(body: Record<string, unknown>): string {
	return sha256(JSON.stringify(normalizeIds(body)));
}

export function hashResponsesRequest(body: Record<string, unknown>): string {
	return sha256(JSON.stringify(normalizeIds(body)));
}

function hashRoundRequest(
	body: Record<string, unknown>,
	wireApi: WireApi,
	transportBound: boolean,
): string {
	if (wireApi === "responses") return hashResponsesRequest(body);
	return transportBound ? hashChatRequest(body) : hashRequest(body);
}

function responseInput(body: Record<string, unknown>): Array<Record<string, unknown>> {
	return Array.isArray(body.input) ? (body.input as Array<Record<string, unknown>>) : [];
}

function digestOf(body: Record<string, unknown>, wireApi: WireApi): CassetteRound["digest"] {
	if (wireApi === "chat-completions") {
		const messages = (body.messages ?? []) as Array<Record<string, unknown>>;
		const lastUser = [...messages].reverse().find((m) => m.role === "user");
		return {
			systemChars: instructionContentTextOf(messages).length,
			toolCount: ((body.tools ?? []) as unknown[]).length,
			roles: messages.map((m) => String(m.role)),
			lastUserText: String(lastUser?.content ?? "").slice(0, 120),
		};
	}
	const input = responseInput(body);
	const instructions = typeof body.instructions === "string" ? body.instructions : "";
	const instructionItems = input.filter(
		(item) => item.role === "system" || item.role === "developer",
	);
	const instructionText = instructionItems
		.map((item) =>
			typeof item.content === "string" ? item.content : JSON.stringify(item.content ?? ""),
		)
		.join("\n");
	const lastUser = [...input].reverse().find((item) => item.role === "user");
	return {
		systemChars: [instructions, instructionText].filter(Boolean).join("\n").length,
		toolCount: ((body.tools ?? []) as unknown[]).length,
		roles: input.map((item) => String(item.role ?? item.type ?? "?")),
		lastUserText: String(lastUser?.content ?? "").slice(0, 120),
	};
}

function captureRequest(
	round: number,
	body: Record<string, unknown>,
	wireApi: WireApi,
): CapturedRequest {
	const digest = digestOf(body, wireApi);
	const tools = (body.tools ?? []) as Array<{ name?: string; function?: { name?: string } }>;
	return {
		round,
		systemChars: digest.systemChars,
		toolNames: tools.map((tool) => tool.name ?? tool.function?.name ?? "?"),
		messages:
			wireApi === "responses"
				? responseInput(body).map((item) => ({
						role: String(item.role ?? item.type ?? "?"),
						content:
							typeof item.content === "string" ? item.content : JSON.stringify(item.content ?? ""),
						toolCalls: item.type === "function_call" ? [String(item.name ?? "?")] : [],
					}))
				: ((body.messages ?? []) as Array<Record<string, unknown>>).map((message) => ({
						role: String(message.role),
						content:
							typeof message.content === "string"
								? message.content
								: JSON.stringify(message.content ?? ""),
						toolCalls: ((message.tool_calls ?? []) as Array<{ function?: { name?: string } }>).map(
							(tool) => tool.function?.name ?? "?",
						),
					})),
		raw: body,
	};
}

function validateResponseEvidence(round: CassetteRound): void {
	if (!round.response) throw new Error(`Responses round ${round.round} has no byte evidence`);
	const bytes = Buffer.from(round.response.bodyBase64, "base64");
	if (bytes.toString("base64") !== round.response.bodyBase64) {
		throw new Error(`Responses round ${round.round} has invalid base64`);
	}
	if (bytes.byteLength !== round.response.byteCount) {
		throw new Error(`Responses round ${round.round} response byte count mismatch`);
	}
	if (sha256(bytes) !== round.response.sha256) {
		throw new Error(`Responses round ${round.round} response sha256 mismatch`);
	}
	const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	if (round.sse !== decoded) throw new Error(`Responses round ${round.round} sse/bytes mismatch`);
	if (containsSecret(decoded)) throw new Error(`Responses round ${round.round} contains a secret`);
	if (
		!Number.isInteger(round.response.status) ||
		round.response.status < 100 ||
		round.response.status > 599
	) {
		throw new Error(`Responses round ${round.round} has invalid HTTP status`);
	}
	if (
		round.response.contentType !== null &&
		(typeof round.response.contentType !== "string" || /[\r\n\0]/.test(round.response.contentType))
	) {
		throw new Error(`Responses round ${round.round} has invalid content type`);
	}
	if (!round.inboundPath || !round.requestBodyBase64 || !round.requestSha256) {
		throw new Error(`Responses round ${round.round} has incomplete request evidence`);
	}
	const requestBytes = Buffer.from(round.requestBodyBase64, "base64");
	if (requestBytes.toString("base64") !== round.requestBodyBase64) {
		throw new Error(`Responses round ${round.round} request base64 invalid`);
	}
	if (
		requestBytes.byteLength !== round.requestByteCount ||
		sha256(requestBytes) !== round.requestSha256
	) {
		throw new Error(`Responses round ${round.round} request byte evidence mismatch`);
	}
	const requestText = new TextDecoder("utf-8", { fatal: true }).decode(requestBytes);
	if (containsSecret(requestText))
		throw new Error(`Responses round ${round.round} request contains a secret`);
	const request = JSON.parse(requestText) as Record<string, unknown>;
	if (hashResponsesRequest(request) !== round.requestHash) {
		throw new Error(`Responses round ${round.round} normalized request hash mismatch`);
	}
}

export function validateCassette(cassette: Cassette): void {
	const declaredWireApi = (cassette as { wireApi?: unknown }).wireApi;
	const hasResponsesEvidence = cassette.rounds.some((round) =>
		[
			"inboundPath",
			"requestBodyBase64",
			"requestByteCount",
			"requestSha256",
			"response",
			"terminalStatus",
		].some((field) => field in round),
	);
	const hasResponsesSseEvents = cassette.rounds.some((round) =>
		ssePayloads(round.sse).some((payload) => {
			const type = (payload as { type?: unknown }).type;
			return typeof type === "string" && type.startsWith("response.");
		}),
	);
	if (declaredWireApi === undefined) {
		if (cassette.transport || hasResponsesEvidence || hasResponsesSseEvents) {
			throw new Error(
				"cassette has transport or Responses evidence without a wireApi discriminator",
			);
		}
		assertChatResolvedModel(cassette);
		return;
	}
	if (declaredWireApi !== "chat-completions" && declaredWireApi !== "responses") {
		throw new Error(`unknown cassette wireApi: ${String(declaredWireApi)}`);
	}
	if (!cassette.transport || cassette.transport.wireApi !== declaredWireApi) {
		throw new Error("cassette wireApi does not match its transport identity");
	}
	const expected = transportIdentity({
		wireApi: declaredWireApi,
		maxOutputTokens:
			declaredWireApi === "responses"
				? (cassette.transport.requestPolicy.maxOutputTokens ?? undefined)
				: undefined,
		limits: cassette.transport.limits,
		publicHeadersSha256: cassette.transport.publicHeadersSha256,
	});
	if (JSON.stringify(expected) !== JSON.stringify(cassette.transport)) {
		throw new Error(`${declaredWireApi} cassette transport identity is invalid`);
	}
	if (declaredWireApi === "chat-completions") {
		if (hasResponsesEvidence || hasResponsesSseEvents) {
			throw new Error("Chat cassette contains Responses-only round evidence");
		}
		assertChatResolvedModel(cassette);
		return;
	}
	for (const round of cassette.rounds) {
		validateResponseEvidence(round);
		if (!cassette.transport.inboundPaths.includes(round.inboundPath as string)) {
			throw new Error(`Responses round ${round.round} inbound path mismatch`);
		}
		const request = JSON.parse(
			new TextDecoder("utf-8", { fatal: true }).decode(
				Buffer.from(round.requestBodyBase64 as string, "base64"),
			),
		) as Record<string, unknown>;
		if (
			JSON.stringify(applyRequestPolicy(request, cassette.transport)) !== JSON.stringify(request)
		) {
			throw new Error(`Responses round ${round.round} request policy mismatch`);
		}
		const terminal = responsesTerminalFromSse(round.sse);
		if (
			terminal.status !== round.terminalStatus ||
			terminal.model !== (cassette.resolvedModel ?? terminal.model)
		) {
			throw new Error(`Responses round ${round.round} terminal metadata mismatch`);
		}
		if (JSON.stringify(terminal.usage) !== JSON.stringify(round.usage)) {
			throw new Error(`Responses round ${round.round} usage mismatch`);
		}
	}
}

function assertChatResolvedModel(cassette: Cassette): void {
	for (const round of cassette.rounds) {
		const model = modelFromSse(round.sse, "chat-completions");
		if (model && cassette.resolvedModel && model !== cassette.resolvedModel) {
			throw new Error(`Chat round ${round.round} model mismatch`);
		}
	}
}

export function readCassette(file: string): Cassette {
	const cassette = JSON.parse(readFileSync(file, "utf8")) as Cassette;
	validateCassette(cassette);
	return cassette;
}

export function mergeRetryCassettes(success: Cassette, prior: readonly Cassette[]): Cassette {
	const attempts = [
		...prior.flatMap((cassette) => cassette.attempts ?? []),
		...(success.attempts ?? []),
	].map((attempt, index) => ({ ...attempt, attempt: index }));
	return { ...success, attempts };
}

export function readCassetteEvidence(file: string): Cassette {
	try {
		return readCassette(file);
	} catch {
		return JSON.parse(readFileSync(file, "utf8")) as Cassette;
	}
}

export function writeCassette(file: string, cassette: Cassette): void {
	validateCassette(cassette);
	const payload = `${JSON.stringify(cassette, null, "\t")}\n`;
	if (containsSecret(payload)) {
		throw new Error(`refus d'écrire la cassette ${file} : le blob contient une valeur secrète`);
	}
	mkdirSync(dirname(file), { recursive: true });
	const temporary = `${file}.tmp-${process.pid}-${randomUUID()}`;
	writeFileSync(temporary, payload, "utf8");
	try {
		renameSync(temporary, file);
	} catch (error) {
		if (existsSync(temporary)) unlinkSync(temporary);
		throw error;
	}
}

export function cassetteExists(file: string): boolean {
	return existsSync(file);
}

async function readIncoming(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
	const chunks: Buffer[] = [];
	let total = 0;
	for await (const chunk of req) {
		const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		total += bytes.byteLength;
		if (total > maxBytes) throw new Error(`request body exceeds ${maxBytes} bytes`);
		chunks.push(bytes);
	}
	return Buffer.concat(chunks);
}

async function readResponseBytes(response: Response, maxBytes: number): Promise<Buffer> {
	if (!response.body) return Buffer.alloc(0);
	const chunks: Uint8Array[] = [];
	let total = 0;
	const reader = response.body.getReader();
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > maxBytes) {
			await reader.cancel();
			throw new Error(`response body exceeds ${maxBytes} bytes`);
		}
		chunks.push(value);
	}
	return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
}

function decodeUtf8(bytes: Uint8Array): string {
	return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function upstreamUrl(base: string, suffix: string): string {
	return `${base.replace(/\/$/, "")}${suffix}`;
}

export async function startRecorder(options: {
	upstream: string;
	file?: string;
	scenario: string;
	provider: string;
	model: string;
	wireApi?: WireApi;
	transport?: TransportIdentity;
	publicHeaders?: PublicHeaderProfile;
	budget?: InvocationBudget;
}): Promise<ModelServerHandle> {
	const wireApi = options.wireApi ?? "chat-completions";
	const transport =
		options.transport ??
		(wireApi === "responses" ? transportIdentity({ wireApi, maxOutputTokens: 2048 }) : undefined);
	if (wireApi === "responses" && !transport) throw new Error("Responses requires transport policy");
	const effectiveTransport =
		transport ??
		transportIdentity({ wireApi: "chat-completions", limits: DEFAULT_TRANSPORT_LIMITS });
	if (effectiveTransport.wireApi !== wireApi) {
		throw new Error("wireApi does not match transport identity");
	}
	const budget = options.budget ?? createInvocationBudget(effectiveTransport.limits);
	const configuredPublicHeaders = options.publicHeaders ?? publicHeaderProfile({});
	if (configuredPublicHeaders.sha256 !== effectiveTransport.publicHeadersSha256) {
		throw new Error("configured public headers do not match transport identity");
	}
	const requests: CapturedRequest[] = [];
	const rounds: CassetteRound[] = [];
	const attempts: CassetteAttempt[] = [];
	let resolvedModel: string | null = null;
	let round = 0;
	let attemptNumber = 0;
	const recordedAt = new Date().toISOString();
	const writeCurrentCassette = (): void => {
		if (!options.file || rounds.length === 0) return;
		writeCassette(options.file, {
			scenario: options.scenario,
			provider: options.provider,
			model: options.model,
			...(resolvedModel ? { resolvedModel } : {}),
			recordedAt,
			rounds: [...rounds].sort((left, right) => left.round - right.round),
			...(wireApi === "responses" || options.wireApi !== undefined || options.transport
				? { wireApi, transport: effectiveTransport }
				: {}),
			attempts: [...attempts],
		});
	};
	const retainAttempt = (attempt: CassetteAttempt): void => {
		attempts.push(attempt);
		if (!options.file) return;
		const attemptFile = `${options.file}.attempts.json`;
		const payload = `${JSON.stringify({ schema: 1, attempts }, null, "\t")}\n`;
		if (containsSecret(payload)) throw new Error("attempt receipt contains a secret");
		mkdirSync(dirname(attemptFile), { recursive: true });
		writeFileSync(attemptFile, payload, "utf8");
		// A later failure has no raw round to append, but it may still have reached
		// the provider. Refresh only the safe attempt metadata on the last complete
		// cassette so measurement accounting cannot silently lose that attempt.
		writeCurrentCassette();
	};

	const server: Server = createServer(async (req, res) => {
		const attempt = attemptNumber++;
		const inboundPath = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
		if (!effectiveTransport.inboundPaths.includes(inboundPath)) {
			retainAttempt({
				attempt,
				phase: "admission",
				status: "rejected",
				detail: "protocol/path mismatch",
			});
			res.writeHead(404, { "content-type": "application/json" });
			res.end('{"error":"workbench proxy: protocol/path mismatch"}');
			return;
		}
		let incoming: Buffer;
		try {
			incoming = await readIncoming(req, effectiveTransport.limits.maxRequestBytes);
		} catch (error) {
			retainAttempt({
				attempt,
				phase: "admission",
				status: "rejected",
				detail: "request body too large",
			});
			res.writeHead(413, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
			return;
		}
		let parsed: Record<string, unknown>;
		try {
			parsed = JSON.parse(decodeUtf8(incoming)) as Record<string, unknown>;
		} catch {
			retainAttempt({
				attempt,
				phase: "admission",
				status: "rejected",
				detail: "request is not UTF-8 JSON",
			});
			res.writeHead(400, { "content-type": "application/json" });
			res.end('{"error":"workbench proxy: request body is not UTF-8 JSON"}');
			return;
		}
		let effectiveBody: Record<string, unknown>;
		try {
			effectiveBody = applyRequestPolicy(parsed, effectiveTransport);
		} catch {
			retainAttempt({
				attempt,
				phase: "admission",
				status: "rejected",
				detail: "request policy mismatch",
			});
			res.writeHead(400, { "content-type": "application/json" });
			res.end('{"error":"workbench proxy: request policy mismatch"}');
			return;
		}
		const effectiveBytes =
			wireApi === "responses" ? Buffer.from(JSON.stringify(effectiveBody)) : incoming;
		if (containsSecret(decodeUtf8(effectiveBytes))) {
			retainAttempt({
				attempt,
				phase: "admission",
				status: "rejected",
				detail: "secret in request body",
			});
			res.writeHead(400, { "content-type": "application/json" });
			res.end('{"error":"workbench proxy: secret in request body"}');
			return;
		}
		try {
			budget.reserveRequest(effectiveBytes.byteLength);
		} catch (error) {
			retainAttempt({
				attempt,
				phase: "admission",
				status: "rejected",
				detail: "invocation budget rejected request",
			});
			res.writeHead(429, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
			return;
		}
		const myRound = round++;
		requests.push(captureRequest(myRound, effectiveBody, wireApi));
		const auth = req.headers.authorization;
		const controller = new AbortController();
		const untrack = budget.track(controller);
		const timeoutMs = Math.min(effectiveTransport.limits.requestTimeoutMs, budget.remainingMs());
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		let upstreamResponse: Response;
		let responseBytes: Buffer;
		try {
			upstreamResponse = await fetch(
				upstreamUrl(options.upstream, effectiveTransport.upstreamPathSuffix),
				{
					method: "POST",
					redirect: "error",
					headers: {
						"content-type": "application/json",
						accept: "text/event-stream",
						...(auth ? { authorization: auth } : {}),
						...configuredPublicHeaders.headers,
					},
					body: new Uint8Array(effectiveBytes),
					signal: controller.signal,
				},
			);
			responseBytes = await readResponseBytes(
				upstreamResponse,
				effectiveTransport.limits.maxResponseBytes,
			);
		} catch {
			retainAttempt({
				attempt,
				phase: "forward",
				status: "failed",
				detail: "redirect, timeout, transport, or body limit",
			});
			res.writeHead(502, { "content-type": "application/json" });
			res.end(
				wireApi === "chat-completions"
					? '{"error":"workbench proxy: upstream redirect or transport failure"}'
					: '{"error":"workbench proxy: upstream redirect, timeout, or transport failure"}',
			);
			return;
		} finally {
			clearTimeout(timer);
			untrack();
		}
		let decoded: string;
		try {
			decoded = decodeUtf8(responseBytes);
		} catch {
			retainAttempt({
				attempt,
				phase: "response",
				status: "failed",
				detail: "response is not valid UTF-8",
			});
			res.writeHead(502, { "content-type": "application/json" });
			res.end('{"error":"workbench proxy: upstream body is not valid UTF-8"}');
			return;
		}
		if (containsSecret(decoded) || (auth && decoded.includes(auth))) {
			retainAttempt({
				attempt,
				phase: "response",
				status: "failed",
				detail: "unsafe upstream response",
			});
			res.writeHead(502, { "content-type": "application/json" });
			res.end('{"error":"workbench proxy: unsafe upstream response"}');
			return;
		}
		let terminal: ResponsesTerminal | undefined;
		try {
			terminal = wireApi === "responses" ? responsesTerminalFromSse(decoded) : undefined;
		} catch {
			retainAttempt({
				attempt,
				phase: "response",
				status: "failed",
				detail: "invalid Responses terminal sequence",
			});
			res.writeHead(502, { "content-type": "application/json" });
			res.end('{"error":"workbench proxy: invalid Responses terminal sequence"}');
			return;
		}
		const observedModel = terminal?.model ?? modelFromSse(decoded, wireApi);
		if (observedModel) {
			if (resolvedModel && observedModel !== resolvedModel) {
				retainAttempt({
					attempt,
					phase: "response",
					status: "failed",
					detail: "resolved model changed mid-measurement",
				});
				res.writeHead(502, { "content-type": "application/json" });
				res.end('{"error":"workbench proxy: resolved model changed mid-measurement"}');
				return;
			}
			resolvedModel = observedModel;
		}
		const usage = terminal?.usage ?? usageFromSse(decoded, wireApi);
		const responseEvidence: ResponseByteEvidence = {
			bodyBase64: responseBytes.toString("base64"),
			byteCount: responseBytes.byteLength,
			sha256: sha256(responseBytes),
			status: upstreamResponse.status,
			contentType: upstreamResponse.headers.get("content-type"),
		};
		const recordedRound: CassetteRound = {
			round: myRound,
			requestHash: hashRoundRequest(
				effectiveBody,
				wireApi,
				Boolean(options.transport || options.wireApi),
			),
			digest: digestOf(effectiveBody, wireApi),
			sse: decoded,
			...(usage ? { usage } : {}),
			...(wireApi === "responses"
				? {
						inboundPath,
						requestBodyBase64: effectiveBytes.toString("base64"),
						requestByteCount: effectiveBytes.byteLength,
						requestSha256: sha256(effectiveBytes),
						response: responseEvidence,
						terminalStatus: terminal?.status ?? "missing",
					}
				: { httpStatus: responseEvidence.status }),
		};
		rounds.push(recordedRound);
		retainAttempt({ attempt, phase: "complete", status: "recorded" });
		const headers: Record<string, string> =
			wireApi === "chat-completions" ? { "content-type": "text/event-stream" } : {};
		if (wireApi === "responses" && responseEvidence.contentType) {
			headers["content-type"] = responseEvidence.contentType;
		}
		res.writeHead(responseEvidence.status, headers);
		res.end(responseBytes);
	});

	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const addr = server.address();
	if (!addr || typeof addr === "string") throw new Error("recorder has no address");
	return {
		url: `http://127.0.0.1:${addr.port}/v1`,
		requests,
		attempts,
		get resolvedModel() {
			return resolvedModel;
		},
		close: () => {
			budget.abort();
			server.close();
		},
	};
}

export interface ReplayHandle extends ModelServerHandle {
	staleRounds: number[];
	servedRounds: Array<{
		round: number;
		terminalStatus: CassetteRound["terminalStatus"] | "legacy-or-unknown";
		usage: Record<string, unknown> | null;
		status: number;
		contentType: string | null;
		bodySha256: string;
	}>;
	assertFresh: () => void;
}

export function strictReplayRequested(): boolean {
	return process.env.WB_STRICT === "1";
}

export async function startReplay(options: {
	file: string;
	onStale?: "warn" | "throw";
}): Promise<ReplayHandle> {
	const cassette = readCassette(options.file);
	const wireApi = cassette.wireApi ?? "chat-completions";
	const transport =
		cassette.transport ??
		transportIdentity({ wireApi: "chat-completions", limits: DEFAULT_TRANSPORT_LIMITS });
	const requests: CapturedRequest[] = [];
	const staleRounds: number[] = [];
	const servedRounds: ReplayHandle["servedRounds"] = [];
	let round = 0;
	const server: Server = createServer(async (req, res) => {
		const inboundPath = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
		if (!transport.inboundPaths.includes(inboundPath)) {
			staleRounds.push(round);
			res.writeHead(404, { "content-type": "application/json" });
			res.end('{"error":"workbench replay: protocol/path mismatch"}');
			return;
		}
		let incoming: Buffer;
		try {
			incoming = await readIncoming(req, transport.limits.maxRequestBytes);
		} catch {
			res.writeHead(413, { "content-type": "application/json" });
			res.end('{"error":"workbench replay: request too large"}');
			return;
		}
		let parsed: Record<string, unknown>;
		try {
			parsed = JSON.parse(decodeUtf8(incoming)) as Record<string, unknown>;
		} catch {
			res.writeHead(400, { "content-type": "application/json" });
			res.end('{"error":"workbench replay: request is not UTF-8 JSON"}');
			return;
		}
		let effectiveBody: Record<string, unknown>;
		try {
			effectiveBody = applyRequestPolicy(parsed, transport);
		} catch {
			staleRounds.push(round);
			res.writeHead(409, { "content-type": "application/json" });
			res.end('{"error":"workbench replay: request policy mismatch"}');
			return;
		}
		const myRound = round++;
		requests.push(captureRequest(myRound, effectiveBody, wireApi));
		const stored = cassette.rounds[myRound];
		if (!stored) {
			staleRounds.push(myRound);
			res.writeHead(409, { "content-type": "application/json" });
			res.end('{"error":"workbench replay: cassette exhausted"}');
			return;
		}
		const requestHash = hashRoundRequest(
			effectiveBody,
			wireApi,
			Boolean(cassette.transport) && wireApi !== "responses",
		);
		if (
			requestHash !== stored.requestHash ||
			(stored.inboundPath && stored.inboundPath !== inboundPath)
		) {
			staleRounds.push(myRound);
		}
		if (wireApi === "responses" && stored.response) {
			const bytes = Buffer.from(stored.response.bodyBase64, "base64");
			const observed = responsesTerminalFromSse(decodeUtf8(bytes));
			servedRounds.push({
				round: myRound,
				terminalStatus: observed.status,
				usage: observed.usage ?? null,
				status: stored.response.status,
				contentType: stored.response.contentType,
				bodySha256: sha256(bytes),
			});
			const headers: Record<string, string> = {};
			if (stored.response.contentType) headers["content-type"] = stored.response.contentType;
			res.writeHead(stored.response.status, headers);
			res.end(bytes);
			return;
		}
		res.writeHead(200, { "content-type": "text/event-stream" });
		servedRounds.push({
			round: myRound,
			terminalStatus: "legacy-or-unknown",
			usage: usageFromSse(stored.sse) ?? null,
			status: 200,
			contentType: "text/event-stream",
			bodySha256: sha256(Buffer.from(stored.sse)),
		});
		res.end(stored.sse);
	});

	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const addr = server.address();
	if (!addr || typeof addr === "string") throw new Error("replay has no address");
	const strict = options.onStale === "throw" || strictReplayRequested();
	return {
		url: `http://127.0.0.1:${addr.port}/v1`,
		requests,
		staleRounds,
		servedRounds,
		assertFresh: () => {
			if (round < cassette.rounds.length) {
				for (let missing = round; missing < cassette.rounds.length; missing += 1) {
					if (!staleRounds.includes(missing)) staleRounds.push(missing);
				}
			}
			if (staleRounds.length === 0) return;
			const message =
				`cassette ${options.file} périmée aux rounds ${staleRounds.join(", ")} — ` +
				"les instructions, schémas, historique, protocole ou politique de transport ont changé";
			if (strict) throw new Error(message);
			process.stderr.write(`[workbench] ${message}\n`);
		},
		close: () => server.close(),
	};
}
