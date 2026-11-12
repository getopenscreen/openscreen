// Google Drive sync: connect an account, upload a project's recording, and replace that same
// Drive file with each export of the project, so the link the user shared keeps pointing at
// the latest edit. The local files are never touched: Drive holds a copy, not the original.
//
// One Drive file per project. The first upload creates it in the `OpenScreen` folder; every
// later upload for the project replaces its content in place (same file id, same link). Uploads
// for one project run one after another, so an export finishing while the recording is still
// uploading lands on top of it rather than racing it into a second file.

import { stat } from "node:fs/promises";
import path from "node:path";
import type {
	DriveProjectState,
	DriveStatus,
	DriveSyncResult,
	DriveVisibility,
} from "../../src/native/contracts";
import { DriveApiError, GoogleDriveApi, videoMimeType } from "./google-drive-api";
import type { DriveFileRecord, GoogleDriveStore } from "./google-drive-store";
import {
	type FetchLike,
	GoogleAuthError,
	type GoogleClient,
	type GoogleTokens,
	refreshAccessToken,
	revokeToken,
	signInWithGoogle,
} from "./google-oauth";

export const DRIVE_CLIENT_ID_ENV = "OPENSCREEN_GOOGLE_CLIENT_ID";
export const DRIVE_CLIENT_SECRET_ENV = "OPENSCREEN_GOOGLE_CLIENT_SECRET";

export interface GoogleDriveServiceDeps {
	store: GoogleDriveStore;
	openExternal: (url: string) => Promise<void>;
	/** Where the OAuth client env vars are read from. Defaults to `process.env`. */
	env?: Readonly<Record<string, string | undefined>>;
	fetchImpl?: FetchLike;
	now?: () => number;
	/** Swapped in tests; production signs in through the browser. */
	signIn?: typeof signInWithGoogle;
}

/** Drive's file name: the project title, made safe, with the video's own extension. */
export function driveFileName(title: string, filePath: string): string {
	const clean = title.replace(/[\\/:*?"<>|\r\n]+/g, " ").trim() || "OpenScreen recording";
	return `${clean}${path.extname(filePath).toLowerCase()}`;
}

export class GoogleDriveService {
	private readonly store: GoogleDriveStore;
	private readonly env: Readonly<Record<string, string | undefined>>;
	private readonly fetchImpl: FetchLike;
	private readonly now: () => number;
	private readonly signIn: typeof signInWithGoogle;
	private readonly api: GoogleDriveApi;
	private tokens: GoogleTokens | null = null;
	private readonly queues = new Map<string, Promise<unknown>>();
	private readonly live = new Map<
		string,
		{ status: "uploading" | "error"; error: string | null }
	>();

	constructor(private readonly deps: GoogleDriveServiceDeps) {
		this.store = deps.store;
		this.env = deps.env ?? process.env;
		this.fetchImpl = deps.fetchImpl ?? fetch;
		this.now = deps.now ?? Date.now;
		this.signIn = deps.signIn ?? signInWithGoogle;
		this.api = new GoogleDriveApi(() => this.accessToken(), this.fetchImpl);
	}

	/** The env var wins over settings, as it does for the LLM providers' keys. */
	private client(): GoogleClient | null {
		const envId = this.env[DRIVE_CLIENT_ID_ENV]?.trim();
		if (envId) {
			return { clientId: envId, clientSecret: this.env[DRIVE_CLIENT_SECRET_ENV]?.trim() || null };
		}
		const { clientId } = this.store.getSettings();
		if (!clientId) return null;
		return { clientId, clientSecret: this.store.getSecrets().clientSecret };
	}

	getStatus(): DriveStatus {
		const settings = this.store.getSettings();
		const clientFromEnv = Boolean(this.env[DRIVE_CLIENT_ID_ENV]?.trim());
		const connected = settings.accountEmail !== null;
		return {
			configured: clientFromEnv || settings.clientId !== null,
			clientFromEnv,
			clientId: settings.clientId,
			connected,
			accountEmail: settings.accountEmail,
			syncEnabled: connected && settings.syncEnabled,
		};
	}

	async setClientCredentials(clientId: string, clientSecret: string): Promise<DriveStatus> {
		const id = clientId.trim();
		if (!id) throw new Error("Enter the OAuth client ID.");
		// A different client cannot use the old client's refresh token.
		if (id !== this.store.getSettings().clientId) await this.forgetAccount();
		await this.store.setSecrets({ clientSecret: clientSecret.trim() || null });
		await this.store.setSettings({ clientId: id });
		return this.getStatus();
	}

	/** Signs in through the browser. Sync is turned on with the connection: connecting is
	 *  the request to sync, and the toggle is there to turn it off again. */
	async connect(): Promise<DriveStatus> {
		const client = this.client();
		if (!client) throw new Error("Add a Google OAuth client ID first.");
		const tokens = await this.signIn(client, {
			openExternal: this.deps.openExternal,
			fetchImpl: this.fetchImpl,
			now: this.now,
		});
		if (!tokens.refreshToken) throw new GoogleAuthError("Google returned no refresh token.");
		await this.store.setSecrets({ refreshToken: tokens.refreshToken });
		this.tokens = tokens;
		await this.store.setSettings({
			accountEmail: tokens.email ?? "Google account",
			syncEnabled: true,
			folderId: null,
		});
		return this.getStatus();
	}

	/** Signs out and revokes the token. Videos already in Drive stay there, and so do their
	 *  links: the project list keeps showing them, and shares keep working. */
	async disconnect(): Promise<DriveStatus> {
		const { refreshToken } = this.store.getSecrets();
		if (refreshToken) await revokeToken(refreshToken, this.fetchImpl).catch(() => undefined);
		await this.forgetAccount();
		return this.getStatus();
	}

	private async forgetAccount(): Promise<void> {
		this.tokens = null;
		if (this.store.getSecrets().refreshToken) await this.store.setSecrets({ refreshToken: null });
		await this.store.setSettings({ accountEmail: null, syncEnabled: false, folderId: null });
	}

	async setSyncEnabled(enabled: boolean): Promise<DriveStatus> {
		if (enabled && !this.getStatus().connected) throw new Error("Connect Google Drive first.");
		await this.store.setSettings({ syncEnabled: enabled });
		return this.getStatus();
	}

	private async accessToken(): Promise<string> {
		if (this.tokens && this.tokens.expiresAt > this.now()) return this.tokens.accessToken;
		const client = this.client();
		const { refreshToken } = this.store.getSecrets();
		if (!client || !refreshToken) throw new Error("Connect Google Drive first.");
		try {
			this.tokens = await refreshAccessToken(client, refreshToken, this.fetchImpl, this.now());
		} catch (error) {
			// Revoked from the Google account page, or expired: say so in settings rather than
			// fail every upload with the same error.
			if (error instanceof GoogleAuthError && error.needsReconnect) await this.forgetAccount();
			throw error;
		}
		return this.tokens.accessToken;
	}

	private stateOf(projectId: string, record: DriveFileRecord | null): DriveProjectState {
		const live = this.live.get(projectId);
		return {
			projectId,
			fileId: record?.fileId ?? null,
			webViewLink: record?.webViewLink ?? null,
			visibility: record?.visibility ?? "private",
			syncedAt: record?.syncedAt ?? null,
			status: live?.status ?? "synced",
			error: live?.error ?? null,
		};
	}

	/** Every project that has a Drive file or an upload under way or failed. */
	listProjects(): Record<string, DriveProjectState> {
		const { files } = this.store.getSettings();
		const ids = new Set([...Object.keys(files), ...this.live.keys()]);
		const states: Record<string, DriveProjectState> = {};
		for (const id of ids) states[id] = this.stateOf(id, files[id] ?? null);
		return states;
	}

	/** Runs `task` after every earlier one for the same project. */
	private enqueue<T>(projectId: string, task: () => Promise<T>): Promise<T> {
		const previous = this.queues.get(projectId) ?? Promise.resolve();
		const next = previous.then(task, task);
		const settled = next.catch(() => undefined);
		this.queues.set(projectId, settled);
		void settled.then(() => {
			if (this.queues.get(projectId) === settled) this.queues.delete(projectId);
		});
		return next;
	}

	/**
	 * Uploads `filePath` as this project's video: a new Drive file the first time, the same
	 * file's content replaced every time after. Does nothing while sync is off, or for a
	 * project the user unsynced.
	 */
	async syncProject(projectId: string, title: string, filePath: string): Promise<DriveSyncResult> {
		if (!this.getStatus().syncEnabled || this.store.getSettings().excluded.includes(projectId)) {
			return { uploaded: false, state: null };
		}
		if (!videoMimeType(filePath)) throw new Error("Only video files are uploaded to Google Drive.");
		const info = await stat(filePath);
		if (!info.isFile()) throw new Error("The video to upload is not a file.");
		return this.enqueue(projectId, async () => {
			this.live.set(projectId, { status: "uploading", error: null });
			try {
				const existing = this.store.getFile(projectId);
				const name = driveFileName(title, filePath);
				const uploaded = await this.uploadInPlace(existing, name, filePath);
				const record: DriveFileRecord = {
					fileId: uploaded.id,
					webViewLink: uploaded.webViewLink,
					// A replacement file (the old one was deleted in Drive) starts private.
					visibility: existing?.fileId === uploaded.id ? existing.visibility : "private",
					syncedAt: new Date(this.now()).toISOString(),
				};
				await this.store.setFile(projectId, record);
				this.live.delete(projectId);
				return { uploaded: true, state: this.stateOf(projectId, record) };
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				this.live.set(projectId, { status: "error", error: message });
				throw error;
			}
		});
	}

	private async uploadInPlace(existing: DriveFileRecord | null, name: string, filePath: string) {
		if (existing) {
			try {
				return await this.api.upload({ filePath, name, fileId: existing.fileId });
			} catch (error) {
				// Deleted in Drive (or no longer this app's): a new file, and a new link, is the
				// only way to keep syncing.
				if (!(error instanceof DriveApiError && error.status === 404)) throw error;
			}
		}
		return this.api.upload({ filePath, name, folderId: await this.folderId() });
	}

	private async folderId(): Promise<string> {
		const cached = this.store.getSettings().folderId;
		if (cached) return cached;
		const folderId = await this.api.ensureFolder();
		await this.store.setSettings({ folderId });
		return folderId;
	}

	async setVisibility(projectId: string, visibility: DriveVisibility): Promise<DriveProjectState> {
		return this.enqueue(projectId, async () => {
			const record = this.store.getFile(projectId);
			if (!record) throw new Error("This project is not in Google Drive.");
			if (!this.getStatus().connected) throw new Error("Connect Google Drive first.");
			await this.api.setVisibility(record.fileId, visibility);
			const next = { ...record, visibility };
			await this.store.setFile(projectId, next);
			return this.stateOf(projectId, next);
		});
	}

	/** Stops syncing the project, for good: its later exports stay local. The copy in Drive
	 *  is kept, and so is its link: unsyncing is not a delete, and anyone it was shared with
	 *  can still open it. */
	async unsync(projectId: string): Promise<void> {
		await this.enqueue(projectId, async () => {
			this.live.delete(projectId);
			await this.store.setFile(projectId, null);
			const { excluded } = this.store.getSettings();
			if (!excluded.includes(projectId)) {
				await this.store.setSettings({ excluded: [...excluded, projectId] });
			}
		});
	}
}
