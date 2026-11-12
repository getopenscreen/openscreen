// Settings for Google Drive sync: whether it is on, which account is connected, and which
// Drive file each project's video was uploaded to.
//
// Same split as McpSettingsStore and LlmConfigStore: everything that is not a credential is
// plain JSON (`google-drive.json`), the refresh token and the OAuth client secret go through
// the OS keychain (`safeStorage`) into `google-drive-credentials.enc`, never plain JSON. The
// encryption is injected so this file stays testable without Electron.
//
// The credentials are decrypted lazily, on the first upload or connect: on macOS the decrypt
// is a Keychain access, which must not happen at startup for someone who never connected.

import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { DriveVisibility } from "../../src/native/contracts";

export interface DriveCredentialCrypto {
	isEncryptionAvailable(): boolean;
	encryptString(plain: string): Buffer;
	decryptString(encrypted: Buffer): string;
}

/** Where a project's video lives in Drive. Written once the first upload succeeds. */
export interface DriveFileRecord {
	fileId: string;
	webViewLink: string;
	visibility: DriveVisibility;
	/** ISO time of the last successful upload: the recording, or the latest export over it. */
	syncedAt: string;
}

export interface DriveSettings {
	/** Upload new recordings and exports. Off keeps the connection but uploads nothing. */
	syncEnabled: boolean;
	/** The user's own OAuth client (a "Desktop app" client in their Google Cloud project). */
	clientId: string | null;
	/** Shown in settings. Its presence is what "connected" means without touching the keychain. */
	accountEmail: string | null;
	/** The `OpenScreen` folder uploads go into, created on the first upload. */
	folderId: string | null;
	files: Record<string, DriveFileRecord>;
	/** Projects the user unsynced: later recordings and exports of them stay local. */
	excluded: string[];
}

export interface DriveSecrets {
	refreshToken: string | null;
	clientSecret: string | null;
}

const EMPTY_SECRETS: DriveSecrets = { refreshToken: null, clientSecret: null };

const nullableString = (value: unknown) =>
	typeof value === "string" && value.length > 0 ? value : null;

function parseFiles(value: unknown): Record<string, DriveFileRecord> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	const files: Record<string, DriveFileRecord> = {};
	for (const [projectId, raw] of Object.entries(value as Record<string, unknown>)) {
		if (!raw || typeof raw !== "object") continue;
		const record = raw as Record<string, unknown>;
		if (typeof record.fileId !== "string" || typeof record.webViewLink !== "string") continue;
		files[projectId] = {
			fileId: record.fileId,
			webViewLink: record.webViewLink,
			visibility: record.visibility === "anyone" ? "anyone" : "private",
			syncedAt: typeof record.syncedAt === "string" ? record.syncedAt : "",
		};
	}
	return files;
}

export class GoogleDriveStore {
	private readonly settingsPath: string;
	private readonly secretsPath: string;
	private settings: DriveSettings;
	private secrets: DriveSecrets | null = null;

	constructor(
		userDataPath: string,
		private readonly crypto: DriveCredentialCrypto,
	) {
		this.settingsPath = path.join(userDataPath, "google-drive.json");
		this.secretsPath = path.join(userDataPath, "google-drive-credentials.enc");
		this.settings = this.readSettings();
	}

	private readSettings(): DriveSettings {
		try {
			const raw = JSON.parse(readFileSync(this.settingsPath, "utf8")) as Record<string, unknown>;
			return {
				syncEnabled: raw.syncEnabled === true,
				clientId: nullableString(raw.clientId),
				accountEmail: nullableString(raw.accountEmail),
				folderId: nullableString(raw.folderId),
				files: parseFiles(raw.files),
				excluded: Array.isArray(raw.excluded)
					? raw.excluded.filter((id): id is string => typeof id === "string")
					: [],
			};
		} catch {
			return {
				syncEnabled: false,
				clientId: null,
				accountEmail: null,
				folderId: null,
				files: {},
				excluded: [],
			};
		}
	}

	getSettings(): DriveSettings {
		return {
			...this.settings,
			files: { ...this.settings.files },
			excluded: [...this.settings.excluded],
		};
	}

	async setSettings(patch: Partial<DriveSettings>): Promise<DriveSettings> {
		this.settings = { ...this.settings, ...patch };
		await fs.writeFile(this.settingsPath, JSON.stringify(this.settings, null, 2), "utf8");
		return this.getSettings();
	}

	getFile(projectId: string): DriveFileRecord | null {
		return this.settings.files[projectId] ?? null;
	}

	async setFile(projectId: string, record: DriveFileRecord | null): Promise<void> {
		const { [projectId]: _previous, ...rest } = this.settings.files;
		await this.setSettings({ files: record ? { ...rest, [projectId]: record } : rest });
	}

	getSecrets(): DriveSecrets {
		if (this.secrets) return { ...this.secrets };
		try {
			const encrypted = readFileSync(this.secretsPath);
			if (this.crypto.isEncryptionAvailable()) {
				const parsed = JSON.parse(this.crypto.decryptString(encrypted)) as Record<string, unknown>;
				this.secrets = {
					refreshToken: nullableString(parsed.refreshToken),
					clientSecret: nullableString(parsed.clientSecret),
				};
				return { ...this.secrets };
			}
		} catch {
			// Nothing stored yet, or unreadable: the user connects again.
		}
		this.secrets = { ...EMPTY_SECRETS };
		return { ...this.secrets };
	}

	/** Throws rather than falling back to plain text when the keychain is unavailable. */
	async setSecrets(patch: Partial<DriveSecrets>): Promise<void> {
		if (!this.crypto.isEncryptionAvailable()) {
			throw new Error("safeStorage is not available on this platform.");
		}
		const next = { ...this.getSecrets(), ...patch };
		await fs.writeFile(this.secretsPath, this.crypto.encryptString(JSON.stringify(next)));
		this.secrets = next;
	}
}
