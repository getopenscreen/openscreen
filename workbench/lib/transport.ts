import { createHash } from "node:crypto";

export type WireApi = "chat-completions" | "responses";

export interface PublicHeaderProfile {
	headers: Record<string, string>;
	sha256: string;
}

export interface TransportLimits {
	maxRequests: number;
	maxRequestBytes: number;
	maxResponseBytes: number;
	requestTimeoutMs: number;
	invocationTimeoutMs: number;
}

export interface TransportIdentity {
	schema: 1;
	wireApi: WireApi;
	inboundPaths: string[];
	upstreamPathSuffix: string;
	requestPolicy: {
		store: false | "unchanged";
		maxOutputField: "max_output_tokens" | "unchanged";
		maxOutputTokens: number | null;
		reasoning: { effort: "medium" } | "unchanged";
	};
	retryPolicy: { sdkMaxRetries: number | "default"; repetitionRetries: number };
	limits: TransportLimits;
	publicHeadersSha256: string;
}

export const DEFAULT_TRANSPORT_LIMITS: TransportLimits = {
	maxRequests: 100,
	maxRequestBytes: 64 * 1024,
	maxResponseBytes: 1024 * 1024,
	requestTimeoutMs: 60_000,
	invocationTimeoutMs: 300_000,
};

function sha256Bytes(value: string | Uint8Array): string {
	return createHash("sha256").update(value).digest("hex");
}

export function canonicalPublicHeaders(headers: Record<string, string>): string {
	return JSON.stringify(
		Object.entries(headers)
			.map(([name, value]) => [name.toLowerCase(), value.trim()] as const)
			.sort(([left], [right]) => left.localeCompare(right)),
	);
}

export function publicHeaderProfile(headers: Record<string, string>): PublicHeaderProfile {
	const normalized: Record<string, string> = {};
	for (const [rawName, rawValue] of Object.entries(headers)) {
		const name = rawName.toLowerCase();
		const value = rawValue.trim();
		if (/[^a-z0-9-]/.test(name) || name in normalized) {
			throw new Error(`invalid or duplicate public header: ${rawName}`);
		}
		if (name !== "user-agent" && name !== "originator") {
			throw new Error(`unsupported public header: ${rawName}`);
		}
		if (!value || value.length > 256 || /[\r\n\0]/.test(value)) {
			throw new Error(`invalid public header value: ${rawName}`);
		}
		normalized[name] = value;
	}
	return { headers: normalized, sha256: sha256Bytes(canonicalPublicHeaders(normalized)) };
}

export function transportIdentity(options: {
	wireApi: WireApi;
	maxOutputTokens?: number;
	limits?: Partial<TransportLimits>;
	publicHeadersSha256?: string;
}): TransportIdentity {
	const limits = { ...DEFAULT_TRANSPORT_LIMITS, ...options.limits };
	if (options.publicHeadersSha256 && !/^[a-f0-9]{64}$/.test(options.publicHeadersSha256)) {
		throw new Error("publicHeadersSha256 must be a lowercase SHA256");
	}
	for (const [name, value] of Object.entries(limits)) {
		if (!Number.isInteger(value) || value <= 0)
			throw new Error(`${name} must be a positive integer`);
	}
	if (options.wireApi === "responses") {
		if (!Number.isInteger(options.maxOutputTokens) || (options.maxOutputTokens ?? 0) <= 0) {
			throw new Error("Responses requires a positive maxOutputTokens policy");
		}
		return {
			schema: 1,
			wireApi: "responses",
			inboundPaths: ["/responses", "/v1/responses"],
			upstreamPathSuffix: "/responses",
			requestPolicy: {
				store: false,
				maxOutputField: "max_output_tokens",
				maxOutputTokens: options.maxOutputTokens as number,
				reasoning: { effort: "medium" },
			},
			retryPolicy: { sdkMaxRetries: 0, repetitionRetries: 0 },
			limits,
			publicHeadersSha256: options.publicHeadersSha256 ?? sha256Bytes("[]"),
		};
	}
	return {
		schema: 1,
		wireApi: "chat-completions",
		inboundPaths: ["/chat/completions", "/v1/chat/completions"],
		upstreamPathSuffix: "/chat/completions",
		requestPolicy: {
			store: "unchanged",
			maxOutputField: "unchanged",
			maxOutputTokens: null,
			reasoning: "unchanged",
		},
		retryPolicy: { sdkMaxRetries: "default", repetitionRetries: 2 },
		limits,
		publicHeadersSha256: options.publicHeadersSha256 ?? sha256Bytes("[]"),
	};
}

export function transportSha256(identity: TransportIdentity): string {
	return sha256Bytes(JSON.stringify(identity));
}

export function measurementTransportSha256(
	agent: TransportIdentity[],
	judge: TransportIdentity | "no-judge",
): string {
	const contract = agent[0];
	for (const profile of agent) {
		if (JSON.stringify(profile) !== JSON.stringify(contract)) {
			throw new Error("measurement mixes incompatible agent transport identities");
		}
	}
	return sha256Bytes(JSON.stringify({ schema: 1, agent: contract ?? null, judge }));
}

export function applyRequestPolicy(
	body: Record<string, unknown>,
	identity: TransportIdentity,
): Record<string, unknown> {
	if (identity.wireApi === "chat-completions") return body;
	if (JSON.stringify(body.reasoning) !== JSON.stringify(identity.requestPolicy.reasoning)) {
		throw new Error("Responses reasoning policy mismatch");
	}
	return {
		...body,
		store: false,
		max_output_tokens: identity.requestPolicy.maxOutputTokens,
	};
}

export interface InvocationBudget {
	readonly limits: TransportLimits;
	readonly startedAt: number;
	readonly requestCount: number;
	reserveRequest: (bodyBytes: number) => number;
	remainingMs: () => number;
	refreshDeadline: () => void;
	track: (controller: AbortController) => () => void;
	abort: () => void;
}

export function createInvocationBudget(limits: TransportLimits): InvocationBudget {
	let startedAt = Date.now();
	let requestCount = 0;
	const controllers = new Set<AbortController>();
	return {
		limits,
		get startedAt() {
			return startedAt;
		},
		get requestCount() {
			return requestCount;
		},
		reserveRequest(bodyBytes) {
			if (bodyBytes > limits.maxRequestBytes) {
				throw new Error(`request body exceeds ${limits.maxRequestBytes} bytes`);
			}
			if (Date.now() - startedAt >= limits.invocationTimeoutMs) {
				throw new Error("invocation deadline exceeded");
			}
			if (requestCount >= limits.maxRequests) {
				throw new Error(`request budget exhausted at ${limits.maxRequests}`);
			}
			requestCount += 1;
			return requestCount;
		},
		remainingMs: () => Math.max(0, limits.invocationTimeoutMs - (Date.now() - startedAt)),
		refreshDeadline() {
			startedAt = Date.now();
		},
		track(controller) {
			controllers.add(controller);
			return () => controllers.delete(controller);
		},
		abort() {
			for (const controller of controllers) controller.abort();
			controllers.clear();
		},
	};
}
