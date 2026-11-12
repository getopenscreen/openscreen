// The handful of Drive v3 REST calls sync needs: a folder, a resumable upload that creates a
// file or replaces the content of an existing one, and the "anyone with the link" permission.
//
// Plain fetch rather than `googleapis`: five endpoints do not justify a large dependency in
// the main process. Replacing a file's content keeps its id, so its link stays the same
// across every export of a project — that is the whole point of updating rather than
// uploading a new file each time.

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import type { DriveVisibility } from "../../src/native/contracts";
import type { FetchLike } from "./google-oauth";

const DRIVE_API = "https://www.googleapis.com/drive/v3";
const DRIVE_UPLOAD = "https://www.googleapis.com/upload/drive/v3";
export const DRIVE_FOLDER_NAME = "OpenScreen";
const FOLDER_MIME = "application/vnd.google-apps.folder";

const VIDEO_MIME_TYPES: Record<string, string> = {
	".mp4": "video/mp4",
	".webm": "video/webm",
	".mov": "video/quicktime",
	".mkv": "video/x-matroska",
};

/** The video's MIME type, or null for anything sync does not upload. */
export function videoMimeType(filePath: string): string | null {
	return VIDEO_MIME_TYPES[path.extname(filePath).toLowerCase()] ?? null;
}

export class DriveApiError extends Error {
	constructor(
		message: string,
		readonly status: number,
	) {
		super(message);
		this.name = "DriveApiError";
	}
}

export interface DriveUploadedFile {
	id: string;
	webViewLink: string;
}

export class GoogleDriveApi {
	constructor(
		private readonly accessToken: () => Promise<string>,
		private readonly fetchImpl: FetchLike = fetch,
	) {}

	private async request(url: string, init: RequestInit = {}): Promise<Response> {
		const headers = new Headers(init.headers);
		headers.set("Authorization", `Bearer ${await this.accessToken()}`);
		const response = await this.fetchImpl(url, { ...init, headers });
		if (!response.ok) {
			const body = (await response.json().catch(() => null)) as {
				error?: { message?: string };
			} | null;
			throw new DriveApiError(
				body?.error?.message ?? `Google Drive request failed: HTTP ${response.status}`,
				response.status,
			);
		}
		return response;
	}

	/** The `OpenScreen` folder this app created, or a new one. `drive.file` only lists files
	 *  the app created, so a same-named folder of the user's own is never picked up. */
	async ensureFolder(): Promise<string> {
		const query = `mimeType='${FOLDER_MIME}' and name='${DRIVE_FOLDER_NAME}' and trashed=false`;
		const list = (await (
			await this.request(`${DRIVE_API}/files?q=${encodeURIComponent(query)}&fields=files(id)`)
		).json()) as { files?: Array<{ id: string }> };
		const existing = list.files?.[0]?.id;
		if (existing) return existing;
		const created = (await (
			await this.request(`${DRIVE_API}/files?fields=id`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name: DRIVE_FOLDER_NAME, mimeType: FOLDER_MIME }),
			})
		).json()) as { id: string };
		return created.id;
	}

	/**
	 * Uploads `filePath` as a new file in `folderId`, or, with `fileId`, replaces that file's
	 * content and name in place. Resumable protocol, sent in one PUT: recordings run to
	 * gigabytes, and a multipart upload would hold the whole file in memory.
	 */
	async upload(options: {
		filePath: string;
		name: string;
		folderId?: string;
		fileId?: string;
	}): Promise<DriveUploadedFile> {
		const mimeType = videoMimeType(options.filePath);
		if (!mimeType) throw new Error("Only video files are uploaded to Google Drive.");
		const { size } = await stat(options.filePath);
		const metadata: Record<string, unknown> = { name: options.name, mimeType };
		if (!options.fileId && options.folderId) metadata.parents = [options.folderId];
		const session = await this.request(
			options.fileId
				? `${DRIVE_UPLOAD}/files/${encodeURIComponent(options.fileId)}?uploadType=resumable`
				: `${DRIVE_UPLOAD}/files?uploadType=resumable`,
			{
				method: options.fileId ? "PATCH" : "POST",
				headers: {
					"Content-Type": "application/json; charset=UTF-8",
					"X-Upload-Content-Type": mimeType,
					"X-Upload-Content-Length": String(size),
				},
				body: JSON.stringify(metadata),
			},
		);
		const location = session.headers.get("location");
		if (!location) throw new DriveApiError("Google Drive returned no upload session.", 0);
		const uploadUrl = new URL(location);
		uploadUrl.searchParams.set("fields", "id,webViewLink");
		const uploaded = (await (
			await this.request(uploadUrl.toString(), {
				method: "PUT",
				headers: { "Content-Type": mimeType, "Content-Length": String(size) },
				body: Readable.toWeb(createReadStream(options.filePath)) as ReadableStream,
				// Required by Node's fetch for a streamed request body.
				duplex: "half",
			} as RequestInit)
		).json()) as Partial<DriveUploadedFile>;
		if (!uploaded.id) throw new DriveApiError("Google Drive returned no file id.", 0);
		return {
			id: uploaded.id,
			webViewLink: uploaded.webViewLink ?? `https://drive.google.com/file/d/${uploaded.id}/view`,
		};
	}

	/** "anyone": anyone with the link can view. "private": only the owner and people they
	 *  shared with by name, i.e. the "anyone" permission removed. */
	async setVisibility(fileId: string, visibility: DriveVisibility): Promise<void> {
		const base = `${DRIVE_API}/files/${encodeURIComponent(fileId)}/permissions`;
		const { permissions = [] } = (await (
			await this.request(`${base}?fields=permissions(id,type)`)
		).json()) as { permissions?: Array<{ id: string; type: string }> };
		const anyone = permissions.filter((permission) => permission.type === "anyone");
		if (visibility === "anyone") {
			if (anyone.length > 0) return;
			await this.request(base, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ type: "anyone", role: "reader" }),
			});
			return;
		}
		for (const permission of anyone) {
			await this.request(`${base}/${encodeURIComponent(permission.id)}`, { method: "DELETE" });
		}
	}
}
