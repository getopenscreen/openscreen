// Google sign-in for Drive sync: OAuth 2.0 for installed apps, with a loopback redirect and
// PKCE (RFC 7636), the flow Google documents for desktop clients.
//
// No client ID ships with OpenScreen. Shipping someone else's, or our own inside a signed
// installer, is exactly what was removed in 1.8.0 for the LLM providers (see
// llm-provider-auth.ts). The user brings a "Desktop app" OAuth client from their own Google
// Cloud project, entered in settings or set through OPENSCREEN_GOOGLE_CLIENT_ID /
// OPENSCREEN_GOOGLE_CLIENT_SECRET.
//
// The scope is `drive.file`: OpenScreen sees and changes only the files it created, never the
// rest of the user's Drive.

import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
export const DRIVE_SCOPES = ["https://www.googleapis.com/auth/drive.file", "openid", "email"];

/** Long enough to sign in and consent, short enough that a forgotten tab frees the port. */
const SIGN_IN_TIMEOUT_MS = 5 * 60 * 1000;

export interface GoogleClient {
	clientId: string;
	clientSecret: string | null;
}

export interface GoogleTokens {
	accessToken: string;
	/** Epoch ms. */
	expiresAt: number;
	refreshToken: string | null;
	email: string | null;
}

export type FetchLike = typeof fetch;

export function base64Url(buffer: Buffer): string {
	return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function createPkcePair(): { verifier: string; challenge: string } {
	const verifier = base64Url(randomBytes(32));
	const challenge = base64Url(createHash("sha256").update(verifier).digest());
	return { verifier, challenge };
}

export function buildAuthUrl(
	clientId: string,
	redirectUri: string,
	challenge: string,
	state: string,
): string {
	const url = new URL(GOOGLE_AUTH_URL);
	url.searchParams.set("client_id", clientId);
	url.searchParams.set("redirect_uri", redirectUri);
	url.searchParams.set("response_type", "code");
	url.searchParams.set("scope", DRIVE_SCOPES.join(" "));
	url.searchParams.set("code_challenge", challenge);
	url.searchParams.set("code_challenge_method", "S256");
	url.searchParams.set("state", state);
	// Offline + consent: a refresh token every time, so a reconnect never ends up without one.
	url.searchParams.set("access_type", "offline");
	url.searchParams.set("prompt", "consent");
	return url.toString();
}

/** The `email` claim of an ID token. Not verified: it came straight from Google's token
 *  endpoint over TLS, and it is only ever shown, never trusted for access. */
export function emailFromIdToken(idToken: unknown): string | null {
	if (typeof idToken !== "string") return null;
	const payload = idToken.split(".")[1];
	if (!payload) return null;
	try {
		const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
			email?: unknown;
		};
		return typeof claims.email === "string" ? claims.email : null;
	} catch {
		return null;
	}
}

async function postToken(
	fetchImpl: FetchLike,
	params: Record<string, string>,
): Promise<Record<string, unknown>> {
	const response = await fetchImpl(GOOGLE_TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams(params).toString(),
	});
	const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
	if (!response.ok) {
		const reason =
			typeof body.error_description === "string"
				? body.error_description
				: typeof body.error === "string"
					? body.error
					: `HTTP ${response.status}`;
		throw new GoogleAuthError(reason, body.error === "invalid_grant");
	}
	return body;
}

export class GoogleAuthError extends Error {
	constructor(
		message: string,
		/** The refresh token was revoked or expired: the user has to connect again. */
		readonly needsReconnect = false,
	) {
		super(message);
		this.name = "GoogleAuthError";
	}
}

function tokensFrom(body: Record<string, unknown>, now: number): GoogleTokens {
	if (typeof body.access_token !== "string") {
		throw new GoogleAuthError("Google returned no access token.");
	}
	const expiresIn = typeof body.expires_in === "number" ? body.expires_in : 3600;
	return {
		accessToken: body.access_token,
		// A minute early, so a token is never used in its last seconds.
		expiresAt: now + Math.max(0, expiresIn - 60) * 1000,
		refreshToken: typeof body.refresh_token === "string" ? body.refresh_token : null,
		email: emailFromIdToken(body.id_token),
	};
}

export async function refreshAccessToken(
	client: GoogleClient,
	refreshToken: string,
	fetchImpl: FetchLike = fetch,
	now = Date.now(),
): Promise<GoogleTokens> {
	const params: Record<string, string> = {
		client_id: client.clientId,
		refresh_token: refreshToken,
		grant_type: "refresh_token",
	};
	if (client.clientSecret) params.client_secret = client.clientSecret;
	const tokens = tokensFrom(await postToken(fetchImpl, params), now);
	return { ...tokens, refreshToken: tokens.refreshToken ?? refreshToken };
}

export async function revokeToken(token: string, fetchImpl: FetchLike = fetch): Promise<void> {
	await fetchImpl(`${GOOGLE_REVOKE_URL}?token=${encodeURIComponent(token)}`, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
	});
}

const DONE_PAGE = `<!doctype html><meta charset="utf-8"><title>OpenScreen</title>
<body style="font:16px system-ui;padding:48px;text-align:center">
<h1>OpenScreen is connected to Google Drive</h1><p>You can close this tab.</p></body>`;
const FAILED_PAGE = `<!doctype html><meta charset="utf-8"><title>OpenScreen</title>
<body style="font:16px system-ui;padding:48px;text-align:center">
<h1>Google Drive was not connected</h1><p>Return to OpenScreen and try again.</p></body>`;

export interface SignInDeps {
	openExternal: (url: string) => Promise<void>;
	fetchImpl?: FetchLike;
	timeoutMs?: number;
	now?: () => number;
}

/**
 * Opens Google's consent page in the user's browser and waits for the redirect on a
 * one-shot server bound to 127.0.0.1 on a free port. Resolves with the tokens, rejects on a
 * denial, a state mismatch or the timeout. The server is closed whatever happens.
 */
export async function signInWithGoogle(
	client: GoogleClient,
	deps: SignInDeps,
): Promise<GoogleTokens> {
	const fetchImpl = deps.fetchImpl ?? fetch;
	const { verifier, challenge } = createPkcePair();
	const state = base64Url(randomBytes(16));
	let server: Server | null = null;
	let timer: NodeJS.Timeout | null = null;
	try {
		const code = await new Promise<{ code: string; redirectUri: string }>((resolve, reject) => {
			let redirectUri = "";
			server = createServer((req, res) => {
				const url = new URL(req.url ?? "/", "http://127.0.0.1");
				// Browsers ask for a favicon too; only the redirect itself settles the flow.
				if (url.pathname !== "/") {
					res.writeHead(404).end();
					return;
				}
				const error = url.searchParams.get("error");
				const returnedCode = url.searchParams.get("code");
				const ok = !error && returnedCode && url.searchParams.get("state") === state;
				res.writeHead(ok ? 200 : 400, { "Content-Type": "text/html; charset=utf-8" });
				res.end(ok ? DONE_PAGE : FAILED_PAGE);
				if (ok) resolve({ code: returnedCode, redirectUri });
				else
					reject(
						new GoogleAuthError(
							error ? `Google sign-in failed: ${error}` : "Google sign-in failed.",
						),
					);
			});
			server.on("error", reject);
			server.listen(0, "127.0.0.1", () => {
				const { port } = (server as Server).address() as AddressInfo;
				redirectUri = `http://127.0.0.1:${port}`;
				deps
					.openExternal(buildAuthUrl(client.clientId, redirectUri, challenge, state))
					.catch(reject);
			});
			timer = setTimeout(
				() => reject(new GoogleAuthError("Google sign-in timed out.")),
				deps.timeoutMs ?? SIGN_IN_TIMEOUT_MS,
			);
		});
		const params: Record<string, string> = {
			client_id: client.clientId,
			code: code.code,
			code_verifier: verifier,
			redirect_uri: code.redirectUri,
			grant_type: "authorization_code",
		};
		if (client.clientSecret) params.client_secret = client.clientSecret;
		return tokensFrom(await postToken(fetchImpl, params), deps.now?.() ?? Date.now());
	} finally {
		if (timer) clearTimeout(timer);
		(server as Server | null)?.close();
	}
}
