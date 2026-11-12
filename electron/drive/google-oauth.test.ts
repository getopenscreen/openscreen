import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
	base64Url,
	buildAuthUrl,
	createPkcePair,
	emailFromIdToken,
	GoogleAuthError,
	refreshAccessToken,
	signInWithGoogle,
} from "./google-oauth";

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function idToken(claims: Record<string, unknown>): string {
	return `x.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.y`;
}

describe("PKCE and the consent URL", () => {
	it("derives the challenge as the S256 hash of the verifier", () => {
		const { verifier, challenge } = createPkcePair();
		expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(challenge).toBe(base64Url(createHash("sha256").update(verifier).digest()));
	});

	it("asks only for the files OpenScreen creates, offline, with PKCE", () => {
		const url = new URL(buildAuthUrl("client-id", "http://127.0.0.1:5000", "challenge", "state"));
		expect(url.searchParams.get("scope")).toBe(
			"https://www.googleapis.com/auth/drive.file openid email",
		);
		expect(url.searchParams.get("code_challenge_method")).toBe("S256");
		expect(url.searchParams.get("access_type")).toBe("offline");
		expect(url.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:5000");
	});

	it("reads the email claim, and nothing from garbage", () => {
		expect(emailFromIdToken(idToken({ email: "me@example.com" }))).toBe("me@example.com");
		expect(emailFromIdToken("not-a-jwt")).toBeNull();
		expect(emailFromIdToken(undefined)).toBeNull();
	});
});

describe("refreshAccessToken", () => {
	it("keeps the refresh token Google did not send back", async () => {
		const fetchImpl = vi.fn(async () => jsonResponse({ access_token: "a", expires_in: 3600 }));
		const tokens = await refreshAccessToken(
			{ clientId: "c", clientSecret: "s" },
			"refresh",
			fetchImpl as unknown as typeof fetch,
			1_000,
		);
		expect(tokens).toMatchObject({ accessToken: "a", refreshToken: "refresh" });
		expect(tokens.expiresAt).toBe(1_000 + 3540 * 1000);
		const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
		const body = new URLSearchParams(String(init.body));
		expect(body.get("grant_type")).toBe("refresh_token");
		expect(body.get("client_secret")).toBe("s");
	});

	it("marks a revoked token as needing a reconnect", async () => {
		const fetchImpl = vi.fn(async () =>
			jsonResponse({ error: "invalid_grant", error_description: "Token has been revoked." }, 400),
		);
		const failure = await refreshAccessToken(
			{ clientId: "c", clientSecret: null },
			"refresh",
			fetchImpl as unknown as typeof fetch,
		).catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(GoogleAuthError);
		expect((failure as GoogleAuthError).needsReconnect).toBe(true);
		expect((failure as Error).message).toBe("Token has been revoked.");
	});
});

describe("signInWithGoogle", () => {
	it("catches the redirect on the loopback server and exchanges the code with the verifier", async () => {
		const tokenFetch = vi.fn(async () =>
			jsonResponse({
				access_token: "access",
				refresh_token: "refresh",
				expires_in: 3600,
				id_token: idToken({ email: "me@example.com" }),
			}),
		);
		const tokens = await signInWithGoogle(
			{ clientId: "client", clientSecret: "secret" },
			{
				fetchImpl: tokenFetch as unknown as typeof fetch,
				openExternal: async (consentUrl) => {
					// Play the browser: Google redirects back with the code and the same state.
					const consent = new URL(consentUrl);
					const redirect = new URL(consent.searchParams.get("redirect_uri") ?? "");
					redirect.searchParams.set("code", "the-code");
					redirect.searchParams.set("state", consent.searchParams.get("state") ?? "");
					const page = await fetch(redirect);
					expect(page.status).toBe(200);
				},
			},
		);
		expect(tokens).toMatchObject({
			accessToken: "access",
			refreshToken: "refresh",
			email: "me@example.com",
		});
		const [, init] = tokenFetch.mock.calls[0] as unknown as [string, RequestInit];
		const body = new URLSearchParams(String(init.body));
		expect(body.get("code")).toBe("the-code");
		expect(body.get("code_verifier")).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(body.get("redirect_uri")).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
	});

	it("rejects a redirect whose state does not match", async () => {
		const tokenFetch = vi.fn();
		await expect(
			signInWithGoogle(
				{ clientId: "client", clientSecret: null },
				{
					fetchImpl: tokenFetch as unknown as typeof fetch,
					openExternal: async (consentUrl) => {
						const consent = new URL(consentUrl);
						const redirect = new URL(consent.searchParams.get("redirect_uri") ?? "");
						redirect.searchParams.set("code", "the-code");
						redirect.searchParams.set("state", "forged");
						await fetch(redirect);
					},
				},
			),
		).rejects.toThrow(GoogleAuthError);
		expect(tokenFetch).not.toHaveBeenCalled();
	});

	it("gives up when the user never finishes", async () => {
		await expect(
			signInWithGoogle(
				{ clientId: "client", clientSecret: null },
				{ openExternal: async () => undefined, timeoutMs: 20 },
			),
		).rejects.toThrow(/timed out/);
	});
});
