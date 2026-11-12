import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	DRIVE_CLIENT_ID_ENV,
	DRIVE_CLIENT_SECRET_ENV,
	driveFileName,
	GoogleDriveService,
} from "./google-drive-service";
import { type DriveCredentialCrypto, GoogleDriveStore } from "./google-drive-store";
import type { signInWithGoogle } from "./google-oauth";

const crypto: DriveCredentialCrypto = {
	isEncryptionAvailable: () => true,
	encryptString: (plain) => Buffer.from(plain),
	decryptString: (encrypted) => encrypted.toString(),
};

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/**
 * A small in-memory Drive behind fetch: files by id, an upload session per request, the
 * token endpoint. Enough to follow a project through create, replace and share.
 */
function fakeGoogle() {
	const files = new Map<string, { name: string; bytes: number; anyone: boolean }>();
	let nextId = 1;
	const sessions = new Map<string, { fileId: string | null; name: string }>();
	const tokenRequests: URLSearchParams[] = [];
	let tokenError: { error: string } | null = null;
	const fetchImpl = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
		const url = new URL(String(input));
		const method = init.method ?? "GET";
		if (url.hostname === "oauth2.googleapis.com") {
			if (url.pathname === "/revoke") return new Response(null);
			const params = new URLSearchParams(String(init.body));
			tokenRequests.push(params);
			if (tokenError) return json(tokenError, 400);
			return json({ access_token: `access-${tokenRequests.length}`, expires_in: 3600 });
		}
		if (url.pathname === "/drive/v3/files" && method === "GET") return json({ files: [] });
		if (url.pathname === "/drive/v3/files" && method === "POST") return json({ id: "folder" });
		const upload = url.pathname.match(/^\/upload\/drive\/v3\/files(?:\/([^/]+))?$/);
		if (upload && (method === "POST" || method === "PATCH")) {
			const fileId = upload[1] ? decodeURIComponent(upload[1]) : null;
			if (fileId && !files.has(fileId)) return json({ error: { message: "File not found" } }, 404);
			const session = `s${sessions.size + 1}`;
			sessions.set(session, { fileId, name: JSON.parse(String(init.body)).name });
			return new Response(null, {
				headers: { Location: `https://upload.example/${session}?upload_id=${session}` },
			});
		}
		if (url.hostname === "upload.example" && method === "PUT") {
			const session = sessions.get(url.pathname.slice(1));
			if (!session) throw new Error("no session");
			const id = session.fileId ?? `file-${nextId++}`;
			const bytes = Number(new Headers(init.headers).get("content-length"));
			files.set(id, { name: session.name, bytes, anyone: files.get(id)?.anyone ?? false });
			return json({ id, webViewLink: `https://drive.google.com/file/d/${id}/view` });
		}
		const permissions = url.pathname.match(/^\/drive\/v3\/files\/([^/]+)\/permissions(?:\/(.+))?$/);
		if (permissions) {
			const file = files.get(permissions[1]);
			if (!file) return json({ error: { message: "File not found" } }, 404);
			if (method === "GET") {
				return json({ permissions: file.anyone ? [{ id: "anyoneWithLink", type: "anyone" }] : [] });
			}
			file.anyone = method === "POST";
			return method === "POST"
				? json({ id: "anyoneWithLink" })
				: new Response(null, { status: 204 });
		}
		throw new Error(`unexpected ${method} ${url}`);
	});
	return {
		files,
		tokenRequests,
		fetchImpl: fetchImpl as unknown as typeof fetch,
		failTokens: (error: string) => {
			tokenError = { error };
		},
	};
}

let dir: string;
let take: string;
let exported: string;
beforeEach(async () => {
	dir = await mkdtemp(path.join(os.tmpdir(), "drive-service-"));
	take = path.join(dir, "recording-1.webm");
	exported = path.join(dir, "Demo.mp4");
	await writeFile(take, Buffer.alloc(100));
	await writeFile(exported, Buffer.alloc(250));
});

function makeService(
	options: {
		env?: Record<string, string | undefined>;
		google?: ReturnType<typeof fakeGoogle>;
	} = {},
) {
	const google = options.google ?? fakeGoogle();
	const store = new GoogleDriveStore(dir, crypto);
	const signIn = vi.fn(async () => ({
		accessToken: "access-0",
		expiresAt: Date.now() + 3_600_000,
		refreshToken: "refresh",
		email: "me@example.com",
	})) as unknown as typeof signInWithGoogle;
	const service = new GoogleDriveService({
		store,
		openExternal: async () => undefined,
		env: options.env ?? {},
		fetchImpl: google.fetchImpl,
		signIn,
	});
	return { service, store, google, signIn };
}

async function connected(options: Parameters<typeof makeService>[0] = {}) {
	const made = makeService(options);
	await made.service.setClientCredentials("client-id", "client-secret");
	await made.service.connect();
	return made;
}

describe("driveFileName", () => {
	it("names the file after the project, with the video's own extension", () => {
		expect(driveFileName("Demo: v2/final", "/x/out.MP4")).toBe("Demo  v2 final.mp4");
		expect(driveFileName("  ", "/x/take.webm")).toBe("OpenScreen recording.webm");
	});
});

describe("GoogleDriveService connection", () => {
	it("needs a client before it can connect", async () => {
		const { service } = makeService();
		expect(service.getStatus()).toMatchObject({ configured: false, connected: false });
		await expect(service.connect()).rejects.toThrow(/client ID/);
	});

	it("takes the client from the environment over settings", async () => {
		const { service, signIn } = makeService({
			env: { [DRIVE_CLIENT_ID_ENV]: "env-id", [DRIVE_CLIENT_SECRET_ENV]: "env-secret" },
		});
		expect(service.getStatus()).toMatchObject({ configured: true, clientFromEnv: true });
		await service.connect();
		expect(signIn).toHaveBeenCalledWith(
			{ clientId: "env-id", clientSecret: "env-secret" },
			expect.anything(),
		);
	});

	it("turns sync on with the connection, and off again on request", async () => {
		const { service } = await connected();
		expect(service.getStatus()).toMatchObject({
			connected: true,
			accountEmail: "me@example.com",
			syncEnabled: true,
		});
		expect((await service.setSyncEnabled(false)).syncEnabled).toBe(false);
	});

	it("cannot turn sync on without a connection", async () => {
		const { service } = makeService();
		await expect(service.setSyncEnabled(true)).rejects.toThrow(/Connect/);
	});

	it("forgets the account on disconnect but keeps what is already in Drive", async () => {
		const { service } = await connected();
		await service.syncProject("proj_1", "Demo", take);
		const status = await service.disconnect();
		expect(status).toMatchObject({ connected: false, syncEnabled: false });
		expect(service.listProjects().proj_1.fileId).toBe("file-1");
	});
});

describe("GoogleDriveService.syncProject", () => {
	it("uploads nothing while sync is off", async () => {
		const { service, google } = await connected();
		await service.setSyncEnabled(false);
		expect(await service.syncProject("proj_1", "Demo", take)).toEqual({
			uploaded: false,
			state: null,
		});
		expect(google.files.size).toBe(0);
	});

	it("puts each export of a project in the same Drive file, so the link never changes", async () => {
		const { service, google } = await connected();
		const first = await service.syncProject("proj_1", "Demo", take);
		const second = await service.syncProject("proj_1", "Demo", exported);
		expect(first.state?.fileId).toBe("file-1");
		expect(second.state?.fileId).toBe("file-1");
		expect(second.state?.webViewLink).toBe(first.state?.webViewLink);
		expect(google.files.size).toBe(1);
		expect(google.files.get("file-1")).toMatchObject({ name: "Demo.mp4", bytes: 250 });
	});

	it("keeps one project's uploads in order when they overlap", async () => {
		const { service, google } = await connected();
		const [recording, exportUpload] = await Promise.all([
			service.syncProject("proj_1", "Demo", take),
			service.syncProject("proj_1", "Demo", exported),
		]);
		expect(recording.state?.fileId).toBe(exportUpload.state?.fileId);
		expect(google.files.get("file-1")?.bytes).toBe(250);
	});

	it("gives separate projects separate files", async () => {
		const { service } = await connected();
		await service.syncProject("proj_1", "One", take);
		await service.syncProject("proj_2", "Two", take);
		const states = service.listProjects();
		expect(states.proj_1.fileId).not.toBe(states.proj_2.fileId);
	});

	it("uploads a new file when the old one was deleted in Drive", async () => {
		const { service, google } = await connected();
		await service.syncProject("proj_1", "Demo", take);
		google.files.delete("file-1");
		const result = await service.syncProject("proj_1", "Demo", exported);
		expect(result.state?.fileId).toBe("file-2");
	});

	it("refuses a missing file before anything reaches Drive", async () => {
		const { service, google } = await connected();
		await expect(
			service.syncProject("proj_1", "Demo", path.join(dir, "missing.mp4")),
		).rejects.toThrow();
		expect(google.files.size).toBe(0);
		expect(service.listProjects().proj_1).toBeUndefined();
	});

	it("shows a failed upload in the list, and clears it on the next success", async () => {
		const google = fakeGoogle();
		const { service, store } = await connected({ google });
		const restarted = new GoogleDriveService({
			store,
			openExternal: async () => undefined,
			env: {},
			fetchImpl: google.fetchImpl,
		});
		google.failTokens("temporarily_unavailable");
		await expect(restarted.syncProject("proj_1", "Demo", take)).rejects.toThrow();
		expect(restarted.listProjects().proj_1).toMatchObject({
			status: "error",
			error: "temporarily_unavailable",
		});
		expect(restarted.getStatus().connected).toBe(true);
		await service.syncProject("proj_1", "Demo", take);
		expect(service.listProjects().proj_1.status).toBe("synced");
	});

	it("refuses a file that is not a video", async () => {
		const { service } = await connected();
		await expect(service.syncProject("proj_1", "Demo", path.join(dir, "x.json"))).rejects.toThrow(
			/video/,
		);
	});

	it("disconnects when Google says the refresh token was revoked", async () => {
		const google = fakeGoogle();
		const { service, store } = await connected({ google });
		// A fresh instance has no access token in memory, so it has to refresh.
		const restarted = new GoogleDriveService({
			store,
			openExternal: async () => undefined,
			env: {},
			fetchImpl: google.fetchImpl,
		});
		google.failTokens("invalid_grant");
		await expect(restarted.syncProject("proj_1", "Demo", take)).rejects.toThrow();
		expect(restarted.getStatus().connected).toBe(false);
		expect(service).toBeDefined();
	});
});

describe("GoogleDriveService visibility and unsync", () => {
	it("shares with anyone with the link, and makes it private again", async () => {
		const { service, google } = await connected();
		await service.syncProject("proj_1", "Demo", take);
		expect((await service.setVisibility("proj_1", "anyone")).visibility).toBe("anyone");
		expect(google.files.get("file-1")?.anyone).toBe(true);
		expect((await service.setVisibility("proj_1", "private")).visibility).toBe("private");
		expect(google.files.get("file-1")?.anyone).toBe(false);
	});

	it("keeps the visibility across later exports", async () => {
		const { service } = await connected();
		await service.syncProject("proj_1", "Demo", take);
		await service.setVisibility("proj_1", "anyone");
		const after = await service.syncProject("proj_1", "Demo", exported);
		expect(after.state?.visibility).toBe("anyone");
	});

	it("unsyncs for good: the Drive copy stays, later exports stay local", async () => {
		const { service, google } = await connected();
		await service.syncProject("proj_1", "Demo", take);
		await service.unsync("proj_1");
		expect(service.listProjects().proj_1).toBeUndefined();
		expect(google.files.has("file-1")).toBe(true);
		expect((await service.syncProject("proj_1", "Demo", exported)).uploaded).toBe(false);
		// Other projects still sync.
		expect((await service.syncProject("proj_2", "Other", take)).uploaded).toBe(true);
	});

	it("cannot change the visibility of a project that is not in Drive", async () => {
		const { service } = await connected();
		await expect(service.setVisibility("proj_9", "anyone")).rejects.toThrow(/not in Google Drive/);
	});
});
