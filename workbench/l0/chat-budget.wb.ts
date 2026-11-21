import { expect, it } from "vitest";
import { applyRequestPolicy, transportIdentity } from "../lib/transport";

it("bounds Chat output explicitly while preserving the historical unbounded profile", () => {
	const original = { messages: [], max_tokens: 9000 };
	const legacy = transportIdentity({ wireApi: "chat-completions" });
	expect(applyRequestPolicy(original, legacy)).toBe(original);
	const bounded = transportIdentity({ wireApi: "chat-completions", maxOutputTokens: 1024 });
	expect(bounded.requestPolicy.maxOutputField).toBe("max_tokens");
	expect(applyRequestPolicy(original, bounded)).toEqual({ messages: [], max_tokens: 1024 });
	expect(bounded.retryPolicy).toEqual({ sdkMaxRetries: 0, repetitionRetries: 0 });
	expect(() => transportIdentity({ wireApi: "chat-completions", maxOutputTokens: 0 })).toThrow();
});
