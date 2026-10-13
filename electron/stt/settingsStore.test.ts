import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TranscriptionSettingsStore } from "./settingsStore";

const folders: string[] = [];
const cipher = {
	isEncryptionAvailable: () => true,
	encryptString: (value: string) => Buffer.from(value.split("").reverse().join("")),
	decryptString: (value: Buffer) => value.toString().split("").reverse().join(""),
};
function folder() {
	const dir = mkdtempSync(path.join(tmpdir(), "openscreen-stt-config-"));
	folders.push(dir);
	return dir;
}
afterEach(() => {
	vi.restoreAllMocks();
	for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true });
});
describe("TranscriptionSettingsStore", () => {
	it("does not call the Linux-only backend API on macOS", () => {
		vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
		const store = new TranscriptionSettingsStore(
			folder(),
			{
				...cipher,
				getSelectedStorageBackend: () => {
					throw new Error("Linux-only API");
				},
			},
			{},
		);
		expect(() =>
			store.update({ provider: "gmi", cloudConsent: true, apiKey: "private-token" }),
		).not.toThrow();
	});
	it("does not activate uploads before cloud consent and a usable credential", () => {
		const store = new TranscriptionSettingsStore(folder(), cipher, {});
		expect(store.getSnapshot()).toEqual({
			provider: "whisper",
			cloudConsent: false,
			agyCloudConsent: false,
			traditionalChinese: false,
			autoTranscribe: true,
			hasApiKey: false,
		});
		expect(() => store.update({ provider: "gmi", apiKey: "private-token" })).toThrow(/consent/i);
		expect(store.getSnapshot().provider).toBe("whisper");
	});
	it("persists encrypted credentials and returns only a boolean to the renderer", () => {
		const dir = folder();
		const store = new TranscriptionSettingsStore(dir, cipher, {});
		store.update({ provider: "gmi", cloudConsent: true, apiKey: "private-token" });
		const restored = new TranscriptionSettingsStore(dir, cipher, {});
		expect(restored.getSnapshot()).toEqual({
			provider: "gmi",
			cloudConsent: true,
			agyCloudConsent: false,
			traditionalChinese: false,
			autoTranscribe: true,
			hasApiKey: true,
		});
		expect(JSON.stringify(restored.getSnapshot())).not.toContain("private-token");
		expect(readFileSync(path.join(dir, "stt-settings.json"), "utf8")).not.toContain(
			"private-token",
		);
		expect(readFileSync(path.join(dir, "stt-credential.enc"), "utf8")).not.toContain(
			"private-token",
		);
		expect(restored.getProviderConfig().apiKey).toBe("private-token");
	});
	it("retains automatic transcription for legacy settings without the flag", () => {
		const dir = folder();
		writeFileSync(
			path.join(dir, "stt-settings.json"),
			JSON.stringify({ provider: "whisper", cloudConsent: false }),
		);
		expect(new TranscriptionSettingsStore(dir, cipher, {}).getSnapshot().autoTranscribe).toBe(true);
	});
	it("disables automatic transcription while retaining provider, consent, and encrypted bytes", () => {
		const dir = folder();
		const store = new TranscriptionSettingsStore(dir, cipher, {});
		store.update({ provider: "gmi", cloudConsent: true, apiKey: "private-token" });
		const savedCredential = readFileSync(path.join(dir, "stt-credential.enc"));
		expect(store.update({ autoTranscribe: false })).toEqual({
			provider: "gmi",
			cloudConsent: true,
			agyCloudConsent: false,
			traditionalChinese: false,
			autoTranscribe: false,
			hasApiKey: true,
		});
		expect(readFileSync(path.join(dir, "stt-credential.enc"))).toEqual(savedCredential);
		expect(new TranscriptionSettingsStore(dir, cipher, {}).getSnapshot().autoTranscribe).toBe(
			false,
		);
	});
	it("allows disabled GMI settings without credentials or consent but rejects reactivation", () => {
		const store = new TranscriptionSettingsStore(folder(), cipher, {});
		expect(store.update({ provider: "gmi", autoTranscribe: false })).toEqual({
			provider: "gmi",
			cloudConsent: false,
			agyCloudConsent: false,
			traditionalChinese: false,
			autoTranscribe: false,
			hasApiKey: false,
		});
		expect(() => store.update({ autoTranscribe: true })).toThrow(/consent/i);
		expect(store.getSnapshot().autoTranscribe).toBe(false);
		expect(() => store.update({ autoTranscribe: true, cloudConsent: true })).toThrow(/key/i);
		expect(store.getSnapshot().autoTranscribe).toBe(false);
	});
	it("does not access OS encryption for disabled startup or snapshots; explicit use decrypts", () => {
		const dir = folder();
		// Legacy encrypted credentials have no presence metadata in their JSON configuration.
		writeFileSync(
			path.join(dir, "stt-settings.json"),
			JSON.stringify({ provider: "gmi", cloudConsent: true, autoTranscribe: false }),
		);
		writeFileSync(path.join(dir, "stt-credential.enc"), cipher.encryptString("private-token"));
		const savedCredential = readFileSync(path.join(dir, "stt-credential.enc"));
		const guardedCipher = {
			...cipher,
			isEncryptionAvailable: vi.fn(cipher.isEncryptionAvailable),
			decryptString: vi.fn(cipher.decryptString),
			encryptString: vi.fn(cipher.encryptString),
		};
		const store = new TranscriptionSettingsStore(dir, guardedCipher, {});
		expect(store.getSnapshot().hasApiKey).toBe(true);
		store.update({ autoTranscribe: false });
		expect(guardedCipher.isEncryptionAvailable).not.toHaveBeenCalled();
		expect(guardedCipher.decryptString).not.toHaveBeenCalled();
		expect(guardedCipher.encryptString).not.toHaveBeenCalled();
		expect(readFileSync(path.join(dir, "stt-credential.enc"))).toEqual(savedCredential);
		expect(store.getProviderConfig().apiKey).toBe("private-token");
		expect(guardedCipher.decryptString).toHaveBeenCalledTimes(1);
	});
	it("does not report a cleared credential as present after a disabled restart", () => {
		const dir = folder();
		// OS ciphers can produce nonempty encrypted data even for an empty plaintext credential.
		const envelopedCipher = {
			...cipher,
			encryptString: (value: string) => Buffer.from(`encrypted:${value}`),
			decryptString: (value: Buffer) => value.toString().slice("encrypted:".length),
		};
		const store = new TranscriptionSettingsStore(dir, envelopedCipher, {});
		store.update({ provider: "gmi", cloudConsent: true, apiKey: "private-token" });
		store.update({ provider: "whisper", autoTranscribe: false, apiKey: "" });
		const decryptString = vi.fn(envelopedCipher.decryptString);
		const restored = new TranscriptionSettingsStore(dir, { ...envelopedCipher, decryptString }, {});
		expect(restored.getSnapshot().hasApiKey).toBe(false);
		expect(restored.getProviderConfig().apiKey).toBeUndefined();
		expect(decryptString).not.toHaveBeenCalled();
	});
	it("keeps an existing key on settings save and disconnects without retaining it", () => {
		const store = new TranscriptionSettingsStore(folder(), cipher, {});
		store.update({ provider: "gmi", cloudConsent: true, apiKey: "private-token" });
		store.update({ provider: "gmi", cloudConsent: true });
		expect(store.getProviderConfig().apiKey).toBe("private-token");
		store.update({ provider: "whisper", cloudConsent: false, apiKey: "" });
		expect(store.getProviderConfig().apiKey).toBeUndefined();
	});
	it("refuses to save plaintext when OS encryption is unavailable", () => {
		const store = new TranscriptionSettingsStore(
			folder(),
			{ ...cipher, isEncryptionAvailable: () => false },
			{},
		);
		expect(() =>
			store.update({ provider: "gmi", cloudConsent: true, apiKey: "private-token" }),
		).toThrow(/encryption/i);
		expect(store.getSnapshot().hasApiKey).toBe(false);
	});
	it("accepts a process environment key without persisting or exposing it", () => {
		const store = new TranscriptionSettingsStore(folder(), cipher, {
			GMI_API_KEY: "environment-token",
		});
		store.update({ provider: "gmi", cloudConsent: true });
		expect(store.getSnapshot().hasApiKey).toBe(true);
		expect(store.getProviderConfig().apiKey).toBe("environment-token");
	});
	it("preserves Chinese script by default and persists an explicit Traditional preference", () => {
		const dir = folder();
		const store = new TranscriptionSettingsStore(dir, cipher, {});
		expect(store.getSnapshot().traditionalChinese).toBe(false);
		store.update({ traditionalChinese: true, autoTranscribe: false });
		expect(
			new TranscriptionSettingsStore(dir, cipher, {}).getProviderConfig().traditionalChinese,
		).toBe(true);
		expect(() => store.update({ traditionalChinese: "yes" } as never)).toThrow(/script preference/);
	});

	it("requires AGY consent separately from GMI and keeps the stored GMI key opaque", () => {
		const dir = folder();
		writeFileSync(
			path.join(dir, "stt-settings.json"),
			JSON.stringify({ provider: "gmi", cloudConsent: true, autoTranscribe: false }),
		);
		writeFileSync(path.join(dir, "stt-credential.enc"), cipher.encryptString("private-token"));
		const decryptString = vi.fn(cipher.decryptString);
		const store = new TranscriptionSettingsStore(dir, { ...cipher, decryptString }, {});
		store.update({ provider: "agy" });
		expect(store.getSnapshot().agyCloudConsent).toBe(false);
		expect(() => store.update({ autoTranscribe: true })).toThrow(/AGY.*consent/);
		store.update({ agyCloudConsent: true, autoTranscribe: true });
		expect(store.getProviderConfig()).toEqual({
			provider: "agy",
			cloudConsent: true,
			agyCloudConsent: true,
			traditionalChinese: false,
			apiKey: undefined,
		});
		expect(decryptString).not.toHaveBeenCalled();
		expect(
			new TranscriptionSettingsStore(dir, { ...cipher, decryptString }, {}).getSnapshot()
				.agyCloudConsent,
		).toBe(true);
		expect(decryptString).not.toHaveBeenCalled();
		expect(store.getSnapshot().hasApiKey).toBe(true);
	});

	it("rejects malformed IPC values without altering the saved configuration", () => {
		const store = new TranscriptionSettingsStore(folder(), cipher, {});
		expect(() => store.update({ provider: "other" } as never)).toThrow();
		expect(() => store.update({ cloudConsent: "yes" } as never)).toThrow();
		expect(() => store.update({ autoTranscribe: "no" } as never)).toThrow();
		expect(() => store.update({ apiKey: 123 } as never)).toThrow();
		expect(store.getSnapshot()).toEqual({
			provider: "whisper",
			cloudConsent: false,
			agyCloudConsent: false,
			traditionalChinese: false,
			autoTranscribe: true,
			hasApiKey: false,
		});
	});
});
