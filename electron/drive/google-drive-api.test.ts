import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DriveApiError, GoogleDriveApi, videoMimeType } from "./google-drive-api";

type Call = { url: string; method: string; headers: Headers; body: unknown };

/** A fake Drive: records every call and answers from `routes` in order. */
function fakeDrive(routes: Array<(call: Call) => Response>) {
	const calls: Call[] = [];
	const fetchImpl = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
		const call: Call = {
			url: String(input),
			method: init.method ?? "GET",
			headers: new Headers(init.headers),
			body: init.body,
		};
		calls.push(call);
		const route = routes.shift();
		if (!route) throw new Error(`unexpected call ${call.method} ${call.url}`);
		return route(call);
	});
	return {
		calls,
		api: new GoogleDriveApi(async () => "token", fetchImpl as unknown as typeof fetch),
	};
}

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

let video: string;
beforeEach(async () => {
	const dir = await mkdtemp(path.join(os.tmpdir(), "drive-api-"));
	video = path.join(dir, "take.mp4");
	await writeFile(video, Buffer.alloc(1234, 1));
});

describe("videoMimeType", () => {
	it("knows the video containers and nothing else", () => {
		expect(videoMimeType("/a/b.MP4")).toBe("video/mp4");
		expect(videoMimeType("/a/b.webm")).toBe("video/webm");
		expect(videoMimeType("/a/b.gif")).toBeNull();
		expect(videoMimeType("/a/b.json")).toBeNull();
	});
});

describe("GoogleDriveApi.upload", () => {
	it("creates a new file in the folder through a resumable session", async () => {
		const { calls, api } = fakeDrive([
			() =>
				new Response(null, {
					status: 200,
					headers: { Location: "https://upload.example/session?upload_id=1" },
				}),
			() => json({ id: "file-1", webViewLink: "https://drive/file-1" }),
		]);
		const uploaded = await api.upload({ filePath: video, name: "Demo.mp4", folderId: "folder" });
		expect(uploaded).toEqual({ id: "file-1", webViewLink: "https://drive/file-1" });
		expect(calls[0].method).toBe("POST");
		expect(calls[0].url).toContain("/upload/drive/v3/files?uploadType=resumable");
		expect(calls[0].headers.get("authorization")).toBe("Bearer token");
		expect(calls[0].headers.get("x-upload-content-length")).toBe("1234");
		expect(JSON.parse(String(calls[0].body))).toEqual({
			name: "Demo.mp4",
			mimeType: "video/mp4",
			parents: ["folder"],
		});
		expect(calls[1].method).toBe("PUT");
		expect(new URL(calls[1].url).searchParams.get("upload_id")).toBe("1");
		expect(calls[1].headers.get("content-length")).toBe("1234");
	});

	it("replaces an existing file's content in place, keeping its id", async () => {
		const { calls, api } = fakeDrive([
			() => new Response(null, { headers: { Location: "https://upload.example/s?upload_id=2" } }),
			() => json({ id: "file-1", webViewLink: "https://drive/file-1" }),
		]);
		const uploaded = await api.upload({ filePath: video, name: "Demo.mp4", fileId: "file-1" });
		expect(uploaded.id).toBe("file-1");
		expect(calls[0].method).toBe("PATCH");
		expect(calls[0].url).toContain("/upload/drive/v3/files/file-1?uploadType=resumable");
		// A file keeps its folder: parents are only set when creating.
		expect(JSON.parse(String(calls[0].body)).parents).toBeUndefined();
	});

	it("reports Drive's own error with its status", async () => {
		const { api } = fakeDrive([() => json({ error: { message: "File not found: x." } }, 404)]);
		const failure = await api
			.upload({ filePath: video, name: "Demo.mp4", fileId: "x" })
			.catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(DriveApiError);
		expect((failure as DriveApiError).status).toBe(404);
		expect((failure as Error).message).toBe("File not found: x.");
	});

	it("refuses anything that is not a video", async () => {
		const { api } = fakeDrive([]);
		await expect(api.upload({ filePath: "/x/notes.txt", name: "n" })).rejects.toThrow(/video/);
	});
});

describe("GoogleDriveApi.setVisibility", () => {
	it("adds the anyone-with-the-link permission once", async () => {
		const { calls, api } = fakeDrive([
			() => json({ permissions: [{ id: "owner", type: "user" }] }),
			() => json({ id: "anyoneWithLink" }),
		]);
		await api.setVisibility("file-1", "anyone");
		expect(calls[1].method).toBe("POST");
		expect(JSON.parse(String(calls[1].body))).toEqual({ type: "anyone", role: "reader" });
	});

	it("removes it to make the file private again", async () => {
		const { calls, api } = fakeDrive([
			() =>
				json({
					permissions: [
						{ id: "owner", type: "user" },
						{ id: "anyoneWithLink", type: "anyone" },
					],
				}),
			() => new Response(null, { status: 204 }),
		]);
		await api.setVisibility("file-1", "private");
		expect(calls[1].method).toBe("DELETE");
		expect(calls[1].url).toMatch(/permissions\/anyoneWithLink$/);
	});
});

describe("GoogleDriveApi.ensureFolder", () => {
	it("reuses the folder it created before", async () => {
		const { calls, api } = fakeDrive([() => json({ files: [{ id: "folder-1" }] })]);
		expect(await api.ensureFolder()).toBe("folder-1");
		expect(calls).toHaveLength(1);
	});

	it("creates it when there is none", async () => {
		const { calls, api } = fakeDrive([() => json({ files: [] }), () => json({ id: "folder-2" })]);
		expect(await api.ensureFolder()).toBe("folder-2");
		expect(JSON.parse(String(calls[1].body))).toEqual({
			name: "OpenScreen",
			mimeType: "application/vnd.google-apps.folder",
		});
	});
});

describe("the streamed upload, through Node's own fetch", () => {
	it("sends every byte of the file in the PUT", async () => {
		const { createServer } = await import("node:http");
		let received = 0;
		const server = createServer((req, res) => {
			req.on("data", (chunk: Buffer) => {
				received += chunk.length;
			});
			req.on("end", () => {
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ id: "file-1", webViewLink: "https://drive/file-1" }));
			});
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const { port } = server.address() as import("node:net").AddressInfo;
		try {
			// The session request goes to a fake Drive; the PUT to the session URL is real fetch.
			const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) =>
				String(input).startsWith("https://www.googleapis.com/")
					? new Response(null, {
							headers: { Location: `http://127.0.0.1:${port}/upload?upload_id=3` },
						})
					: fetch(input, init)) as typeof fetch;
			const api = new GoogleDriveApi(async () => "token", fetchImpl);
			expect(await api.upload({ filePath: video, name: "Demo.mp4", folderId: "f" })).toEqual({
				id: "file-1",
				webViewLink: "https://drive/file-1",
			});
			expect(received).toBe(1234);
		} finally {
			server.close();
		}
	});
});
