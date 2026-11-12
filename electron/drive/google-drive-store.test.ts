import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { type DriveCredentialCrypto, GoogleDriveStore } from "./google-drive-store";

// Reversible and visibly not plain text, so a test can tell an encrypted write from a plain one.
const crypto: DriveCredentialCrypto = {
	isEncryptionAvailable: () => true,
	encryptString: (plain) => Buffer.from(`enc:${Buffer.from(plain).toString("base64")}`),
	decryptString: (encrypted) =>
		Buffer.from(encrypted.toString().replace(/^enc:/, ""), "base64").toString(),
};

let dir: string;
beforeEach(async () => {
	dir = await mkdtemp(path.join(os.tmpdir(), "drive-store-"));
});

describe("GoogleDriveStore", () => {
	it("starts off, with nothing connected and nothing synced", () => {
		const store = new GoogleDriveStore(dir, crypto);
		expect(store.getSettings()).toEqual({
			syncEnabled: false,
			clientId: null,
			accountEmail: null,
			folderId: null,
			files: {},
			excluded: [],
		});
		expect(store.getSecrets()).toEqual({ refreshToken: null, clientSecret: null });
	});

	it("persists settings and project files across instances", async () => {
		const store = new GoogleDriveStore(dir, crypto);
		await store.setSettings({ syncEnabled: true, clientId: "client", accountEmail: "a@b.c" });
		await store.setFile("proj_1", {
			fileId: "file-1",
			webViewLink: "https://drive.google.com/file/d/file-1/view",
			visibility: "anyone",
			syncedAt: "2026-11-12T00:00:00.000Z",
		});
		const reread = new GoogleDriveStore(dir, crypto);
		expect(reread.getSettings().syncEnabled).toBe(true);
		expect(reread.getFile("proj_1")?.visibility).toBe("anyone");
		await reread.setFile("proj_1", null);
		expect(new GoogleDriveStore(dir, crypto).getFile("proj_1")).toBeNull();
	});

	it("keeps credentials out of the plain JSON", async () => {
		const store = new GoogleDriveStore(dir, crypto);
		await store.setSettings({ clientId: "client" });
		await store.setSecrets({ refreshToken: "refresh-secret", clientSecret: "client-secret" });
		const plain = await readFile(path.join(dir, "google-drive.json"), "utf8");
		const encrypted = await readFile(path.join(dir, "google-drive-credentials.enc"), "utf8");
		expect(plain).not.toContain("refresh-secret");
		expect(encrypted).not.toContain("refresh-secret");
		expect(new GoogleDriveStore(dir, crypto).getSecrets()).toEqual({
			refreshToken: "refresh-secret",
			clientSecret: "client-secret",
		});
	});

	it("refuses to store credentials without the keychain rather than fall back to plain text", async () => {
		const store = new GoogleDriveStore(dir, { ...crypto, isEncryptionAvailable: () => false });
		await expect(store.setSecrets({ refreshToken: "x" })).rejects.toThrow(/safeStorage/);
	});

	it("reads a hand-edited file defensively", async () => {
		await writeFile(
			path.join(dir, "google-drive.json"),
			JSON.stringify({
				syncEnabled: "yes",
				clientId: 7,
				files: { ok: { fileId: "f", webViewLink: "l", visibility: "public" }, bad: { fileId: 1 } },
				excluded: ["proj_1", 3],
			}),
		);
		const settings = new GoogleDriveStore(dir, crypto).getSettings();
		expect(settings.syncEnabled).toBe(false);
		expect(settings.clientId).toBeNull();
		expect(Object.keys(settings.files)).toEqual(["ok"]);
		expect(settings.files.ok.visibility).toBe("private");
		expect(settings.excluded).toEqual(["proj_1"]);
	});
});
