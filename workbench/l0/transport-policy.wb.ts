// L0 — transport policy is explicit, finite, and attributable to one env
// contract. These tests use synthetic values and pure helpers only; no provider
// or credential source is contacted.

import { describe, expect, it } from "vitest";
import { ENV_KEYS, hasLiveEnv, requireLiveEnv } from "../lib/env";
import {
	applyRequestPolicy,
	canonicalPublicHeaders,
	createInvocationBudget,
	DEFAULT_TRANSPORT_LIMITS,
	measurementTransportSha256,
	publicHeaderProfile,
	type TransportIdentity,
	type TransportLimits,
	transportIdentity,
	transportSha256,
} from "../lib/transport";

type EnvField = keyof typeof ENV_KEYS;
type EnvFixture = Partial<Record<EnvField, string>>;

const envFields: EnvField[] = ["apiKey", "baseUrl", "model", "wireApi", "userAgent", "originator"];

function withEnv<T>(values: EnvFixture, run: () => T): T {
	const names = Object.values(ENV_KEYS);
	const saved = new Map(names.map((name) => [name, process.env[name]]));
	for (const name of names) delete process.env[name];
	for (const [field, value] of Object.entries(values) as Array<[EnvField, string | undefined]>) {
		if (value !== undefined) process.env[ENV_KEYS[field]] = value;
	}
	try {
		return run();
	} finally {
		for (const name of names) {
			const value = saved.get(name);
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	}
}

function responseIdentity(
	publicHeadersSha256: string,
	limits: Partial<TransportLimits> = {},
): TransportIdentity {
	return transportIdentity({
		wireApi: "responses",
		maxOutputTokens: 2048,
		publicHeadersSha256,
		limits,
	});
}

function cloneIdentity(identity: TransportIdentity): TransportIdentity {
	return JSON.parse(JSON.stringify(identity)) as TransportIdentity;
}

describe("workbench environment contract", () => {
	it("uses the declared env fields and defaults to legacy Chat mode", () => {
		expect(Object.keys(ENV_KEYS)).toEqual(envFields);

		withEnv(
			{
				apiKey: "synthetic-l0-key",
				baseUrl: "http://127.0.0.1:4455/v1/",
				model: "gpt-5.6-luna",
			},
			() => {
				expect(hasLiveEnv()).toBe(true);
				expect(requireLiveEnv()).toMatchObject({
					model: "gpt-5.6-luna",
					baseUrl: "http://127.0.0.1:4455/v1",
					wireApi: "chat-completions",
					publicHeaders: { headers: {} },
				});
			},
		);
	});

	it("accepts an explicit Responses mode and trims its public headers", () => {
		withEnv(
			{
				apiKey: "synthetic-l0-key",
				baseUrl: "http://127.0.0.1:4455/v1",
				model: "gpt-5.6-luna",
				wireApi: "responses",
				userAgent: "  public-agent/1  ",
				originator: " public-originator ",
			},
			() => {
				const env = requireLiveEnv();
				expect(env.wireApi).toBe("responses");
				expect(env.publicHeaders.headers).toEqual({
					"user-agent": "public-agent/1",
					originator: "public-originator",
				});
				expect(env.publicHeaders.sha256).toHaveLength(64);
			},
		);
	});

	it("fails closed for a missing required field or an unknown explicit mode", () => {
		withEnv({ apiKey: "synthetic-l0-key", baseUrl: "http://127.0.0.1:4455/v1" }, () => {
			expect(hasLiveEnv()).toBe(false);
			expect(() => requireLiveEnv()).toThrow();
		});

		withEnv(
			{
				apiKey: "synthetic-l0-key",
				baseUrl: "http://127.0.0.1:4455/v1",
				model: "gpt-5.6-luna",
				wireApi: "unknown-mode",
			},
			() => expect(() => requireLiveEnv()).toThrow(/chat-completions ou responses/),
		);
	});
});

describe("public header policy", () => {
	it("normalizes values, is key-order stable, and fingerprints the full profile", () => {
		const first = publicHeaderProfile({
			"User-Agent": "  public-agent/1  ",
			Originator: "public-originator",
		});
		const second = publicHeaderProfile({
			originator: "public-originator",
			"user-agent": "public-agent/1",
		});

		expect(first.headers).toEqual({
			"user-agent": "public-agent/1",
			originator: "public-originator",
		});
		expect(first.sha256).toBe(second.sha256);
		expect(canonicalPublicHeaders(first.headers)).toBe(canonicalPublicHeaders(second.headers));
		expect(
			publicHeaderProfile({ "user-agent": "public-agent/2", originator: "public-originator" })
				.sha256,
		).not.toBe(first.sha256);
	});

	it("rejects duplicate, unsupported, empty, oversized, and control-character headers", () => {
		expect(() => publicHeaderProfile({ "User-Agent": "one", "user-agent": "two" })).toThrow(
			/duplicate/,
		);
		expect(() => publicHeaderProfile({ "x-test": "value" })).toThrow(/unsupported/);
		expect(() => publicHeaderProfile({ "user-agent": " " })).toThrow(/invalid public header value/);
		expect(() => publicHeaderProfile({ "user-agent": "a".repeat(257) })).toThrow(
			/invalid public header value/,
		);
		for (const value of ["line\rbreak", "line\nbreak", `line${String.fromCharCode(0)}break`]) {
			expect(() => publicHeaderProfile({ "user-agent": value })).toThrow(
				/invalid public header value/,
			);
		}
	});
});

describe("transport identity and request policy", () => {
	it("records the native Responses path, policy, retries, and all configured limits", () => {
		const headers = publicHeaderProfile({ "user-agent": "public-agent/1" });
		const identity = responseIdentity(headers.sha256, {
			maxRequests: 6,
			maxRequestBytes: 64 * 1024,
			maxResponseBytes: 1024 * 1024,
			requestTimeoutMs: 60_000,
			invocationTimeoutMs: 180_000,
		});

		expect(identity).toMatchObject({
			schema: 1,
			wireApi: "responses",
			inboundPaths: ["/responses", "/v1/responses"],
			upstreamPathSuffix: "/responses",
			requestPolicy: {
				store: false,
				maxOutputField: "max_output_tokens",
				maxOutputTokens: 2048,
				reasoning: { effort: "medium" },
			},
			retryPolicy: { sdkMaxRetries: 0, repetitionRetries: 0 },
			limits: {
				maxRequests: 6,
				maxRequestBytes: 64 * 1024,
				maxResponseBytes: 1024 * 1024,
				requestTimeoutMs: 60_000,
				invocationTimeoutMs: 180_000,
			},
			publicHeadersSha256: headers.sha256,
		});
	});

	it("applies store, output, and reasoning policy without mutating the inbound body", () => {
		const identity = responseIdentity(publicHeaderProfile({}).sha256);
		const inbound: Record<string, unknown> = {
			model: "gpt-5.6-luna",
			input: [{ type: "message", role: "user", content: "Zoom the clip." }],
			reasoning: { effort: "medium" },
			store: true,
			max_output_tokens: 1,
		};

		const effective = applyRequestPolicy(inbound, identity);
		expect(effective).toEqual({ ...inbound, store: false, max_output_tokens: 2048 });
		expect(inbound).toEqual({
			model: "gpt-5.6-luna",
			input: [{ type: "message", role: "user", content: "Zoom the clip." }],
			reasoning: { effort: "medium" },
			store: true,
			max_output_tokens: 1,
		});
		expect(() =>
			applyRequestPolicy({ ...inbound, reasoning: { effort: "low" } }, identity),
		).toThrow(/reasoning policy mismatch/);
	});

	it("changes the transport fingerprint for every material protocol or policy field", () => {
		const headers = publicHeaderProfile({
			"user-agent": "public-agent/1",
			originator: "public-originator",
		});
		const identity = responseIdentity(headers.sha256, {
			maxRequests: 6,
			maxRequestBytes: 64 * 1024,
			maxResponseBytes: 1024 * 1024,
			requestTimeoutMs: 60_000,
			invocationTimeoutMs: 180_000,
		});
		const baseline = transportSha256(identity);

		const protocol = transportIdentity({
			wireApi: "chat-completions",
			publicHeadersSha256: headers.sha256,
		});
		expect(transportSha256(protocol)).not.toBe(baseline);

		const mutations: Array<[string, (value: TransportIdentity) => void]> = [
			["inbound path", (value) => (value.inboundPaths[0] = "/responses-v2")],
			["upstream path", (value) => (value.upstreamPathSuffix = "/responses-v2")],
			["store policy", (value) => (value.requestPolicy.store = "unchanged")],
			["output field policy", (value) => (value.requestPolicy.maxOutputField = "unchanged")],
			["output token policy", (value) => (value.requestPolicy.maxOutputTokens = 1025)],
			["reasoning policy", (value) => (value.requestPolicy.reasoning = "unchanged")],
			["SDK retry policy", (value) => (value.retryPolicy.sdkMaxRetries = 1)],
			["repetition retry policy", (value) => (value.retryPolicy.repetitionRetries = 1)],
			[
				"public header profile",
				(value) =>
					(value.publicHeadersSha256 = publicHeaderProfile({
						"user-agent": "public-agent/2",
						originator: "public-originator",
					}).sha256),
			],
		];

		for (const [label, mutate] of mutations) {
			const changed = cloneIdentity(identity);
			mutate(changed);
			expect(transportSha256(changed), label).not.toBe(baseline);
		}

		const budgetFields: Array<keyof TransportLimits> = [
			"maxRequests",
			"maxRequestBytes",
			"maxResponseBytes",
			"requestTimeoutMs",
			"invocationTimeoutMs",
		];
		for (const field of budgetFields) {
			const changed = cloneIdentity(identity);
			changed.limits[field] += 1;
			expect(transportSha256(changed), field).not.toBe(baseline);
		}

		expect(transportSha256(identity)).toHaveLength(64);
	});

	it("binds agent order and the optional judge profile into the measurement fingerprint", () => {
		const headers = publicHeaderProfile({}).sha256;
		const agent = responseIdentity(headers);
		const secondAgent = responseIdentity(headers, { maxRequests: 7 });
		const judge = transportIdentity({ wireApi: "responses", maxOutputTokens: 512 });

		const noJudge = measurementTransportSha256([agent], "no-judge");
		expect(noJudge).toBe(measurementTransportSha256([cloneIdentity(agent)], "no-judge"));
		expect(measurementTransportSha256([agent], judge)).not.toBe(noJudge);
		expect(measurementTransportSha256([agent, secondAgent], "no-judge")).not.toBe(
			measurementTransportSha256([secondAgent, agent], "no-judge"),
		);
	});
});

describe("transport validation and invocation budget", () => {
	it("rejects every non-positive or non-integer configured limit", () => {
		const invalidValues = [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY];
		const fields: Array<keyof TransportLimits> = [
			"maxRequests",
			"maxRequestBytes",
			"maxResponseBytes",
			"requestTimeoutMs",
			"invocationTimeoutMs",
		];

		for (const field of fields) {
			for (const value of invalidValues) {
				const limits = { [field]: value } as Partial<TransportLimits>;
				expect(() =>
					transportIdentity({ wireApi: "responses", maxOutputTokens: 1, limits }),
				).toThrow(field);
			}
		}

		for (const value of [...invalidValues, undefined] as Array<number | undefined>) {
			expect(() => transportIdentity({ wireApi: "responses", maxOutputTokens: value })).toThrow(
				/positive maxOutputTokens/,
			);
		}
	});

	it("shares one request budget and aborts all currently tracked requests", () => {
		const limits: TransportLimits = {
			...DEFAULT_TRANSPORT_LIMITS,
			maxRequests: 2,
			maxRequestBytes: 4,
			requestTimeoutMs: 10_000,
			invocationTimeoutMs: 30_000,
		};
		const budget = createInvocationBudget(limits);

		expect(budget.reserveRequest(4)).toBe(1);
		expect(() => budget.reserveRequest(5)).toThrow(/exceeds 4/);
		expect(budget.requestCount).toBe(1);
		expect(budget.reserveRequest(1)).toBe(2);
		const beforeRefresh = budget.startedAt;
		budget.refreshDeadline();
		expect(budget.startedAt).toBeGreaterThanOrEqual(beforeRefresh);
		expect(budget.requestCount).toBe(2);
		expect(() => budget.reserveRequest(1)).toThrow(/budget exhausted at 2/);
		expect(budget.requestCount).toBe(2);

		const active = new AbortController();
		const released = new AbortController();
		const releaseActive = budget.track(active);
		const releaseReleased = budget.track(released);
		releaseReleased();
		budget.abort();
		expect(active.signal.aborted).toBe(true);
		expect(released.signal.aborted).toBe(false);
		releaseActive();

		const later = new AbortController();
		budget.track(later);
		budget.abort();
		expect(later.signal.aborted).toBe(true);
	});
});
